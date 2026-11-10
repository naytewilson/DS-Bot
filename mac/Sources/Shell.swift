import Foundation

struct CommandResult: Sendable {
    let status: Int32
    let stdout: String
    let stderr: String
    var ok: Bool { status == 0 }

    /// First non-empty stderr line (never stdout: stdout may carry a login token).
    var errorLine: String {
        let line = stderr.split(whereSeparator: \.isNewline).first.map(String.init) ?? ""
        return line.isEmpty ? "exit status \(status)" : line
    }
}

private final class Buffer: @unchecked Sendable {
    private let lock = NSLock()
    private var data = Data()
    func set(_ d: Data) { lock.lock(); data = d; lock.unlock() }
    var string: String { lock.lock(); defer { lock.unlock() }; return String(decoding: data, as: UTF8.self) }
}

enum Shell {
    static let dsbotPath = NSHomeDirectory() + "/.local/bin/dsbot"

    static func run(_ path: String, _ args: [String], timeout: TimeInterval = 25) async -> CommandResult {
        await withCheckedContinuation { cont in
            DispatchQueue.global(qos: .userInitiated).async {
                cont.resume(returning: runSync(path, args, timeout: timeout))
            }
        }
    }

    static func dsbot(_ sub: String) async -> CommandResult {
        await run(dsbotPath, [sub])
    }

    private static func runSync(_ path: String, _ args: [String], timeout: TimeInterval) -> CommandResult {
        let p = Process()
        p.executableURL = URL(fileURLWithPath: path)
        p.arguments = args
        var env = ProcessInfo.processInfo.environment
        let extra = "\(NSHomeDirectory())/.local/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"
        env["PATH"] = extra + (env["PATH"].map { ":" + $0 } ?? "")
        p.environment = env
        let out = Pipe(), err = Pipe()
        p.standardOutput = out
        p.standardError = err
        p.standardInput = FileHandle.nullDevice
        do { try p.run() } catch {
            return CommandResult(status: 127, stdout: "", stderr: "cannot run \(path): \(error.localizedDescription)")
        }
        let outBuf = Buffer(), errBuf = Buffer()
        let group = DispatchGroup()
        for (pipe, buf) in [(out, outBuf), (err, errBuf)] {
            group.enter()
            DispatchQueue.global().async {
                buf.set(pipe.fileHandleForReading.readDataToEndOfFile())
                group.leave()
            }
        }
        let killer = DispatchWorkItem { if p.isRunning { p.terminate() } }
        DispatchQueue.global().asyncAfter(deadline: .now() + timeout, execute: killer)
        p.waitUntilExit()
        killer.cancel()
        group.wait()
        return CommandResult(status: p.terminationStatus,
                             stdout: outBuf.string.trimmingCharacters(in: .whitespacesAndNewlines),
                             stderr: errBuf.string.trimmingCharacters(in: .whitespacesAndNewlines))
    }
}
