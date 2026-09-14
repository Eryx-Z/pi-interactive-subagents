import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { StringDecoder } from "node:string_decoder";
import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";

export type RpcEvent = { type: string; [key: string]: any };
export interface RpcLaunch { command: string; args: string[]; cwd: string; env?: NodeJS.ProcessEnv }

/** Strict LF framing with UTF-8 streaming decode, not readline's additional delimiters. */
export class JsonlDecoder {
  private decoder = new StringDecoder("utf8");
  private buffer = "";
  constructor(private receive: (event: RpcEvent) => void, private maxBytes = 16 * 1024 * 1024) {}
  push(chunk: Buffer): void {
    this.buffer += this.decoder.write(chunk);
    let newline: number;
    while ((newline = this.buffer.indexOf("\n")) >= 0) {
      const line = this.buffer.slice(0, newline).replace(/\r$/, "");
      this.buffer = this.buffer.slice(newline + 1);
      if (Buffer.byteLength(line) > this.maxBytes) throw new Error("RPC frame exceeds limit");
      if (line.trim()) {
        const event = JSON.parse(line);
        if (!event || typeof event.type !== "string") throw new Error("Invalid RPC event");
        this.receive(event);
      }
    }
    if (Buffer.byteLength(this.buffer) > this.maxBytes) throw new Error("RPC frame exceeds limit");
  }
}
export class RpcProcess extends EventEmitter {
  private child: ChildProcessWithoutNullStreams;
  private pending = new Map<string, { type: string; resolve: (data: any) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> }>();
  private closed = false;
  private stopping?: Promise<void>;
  private exitPromise: Promise<void>;
  private stderr = "";
  constructor(launch: RpcLaunch, private timeoutMs = 15000, private graceMs = 1500) {
    super();
    this.child = spawn(launch.command, launch.args, { cwd: launch.cwd, env: launch.env, stdio: "pipe", detached: process.platform !== "win32" });
    const decoder = new JsonlDecoder(e => this.receive(e));
    this.child.stdout.on("data", (chunk: Buffer) => {
      try { decoder.push(chunk); } catch (e) { this.fail(e as Error); void this.stop().catch(() => {}); }
    });
    this.child.stderr.on("data", (b: Buffer) => { this.stderr = (this.stderr + b.toString()).slice(-8000); });
    this.child.stdin.on("error", e => this.fail(e));
    this.child.on("error", e => this.fail(e));
    this.exitPromise = new Promise(resolve => this.child.on("close", (code, signal) => {
      this.closed = true;
      this.rejectPending(new Error(`RPC process closed (${code ?? signal}): ${this.stderr}`));
      this.emit("closed", { code, signal, stderr: this.stderr });
      resolve();
    }));
  }
  private fail(error: Error): void { this.rejectPending(error); this.emit("fault", error); }
  private rejectPending(error: Error): void {
    for (const p of this.pending.values()) { clearTimeout(p.timer); p.reject(error); }
    this.pending.clear();
  }
  private receive(event: RpcEvent): void {
    if (event.type === "response") {
      const p = this.pending.get(event.id);
      if (!p) return;
      this.pending.delete(event.id); clearTimeout(p.timer);
      if (event.command !== p.type) p.reject(new Error("RPC response command mismatch"));
      else if (event.success !== true) p.reject(new Error(event.error || "RPC rejected request"));
      else p.resolve(event.data);
    } else this.emit("event", event);
  }
  send(event: RpcEvent): void {
    if (this.closed || this.child.stdin.destroyed) throw new Error("RPC process is closed");
    this.child.stdin.write(JSON.stringify(event) + "\n");
  }
  request(type: string, fields: Record<string, unknown> = {}): Promise<any> {
    if (this.closed || this.stopping) return Promise.reject(new Error("RPC process is stopping"));
    const id = randomUUID();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        const error = new Error(`RPC ${type} timed out; acceptance/execution is unknown`);
        reject(error); this.fail(error); void this.stop().catch(() => {});
      }, this.timeoutMs);
      this.pending.set(id, { type, resolve, reject, timer });
      try { this.send({ ...fields, type, id }); }
      catch (e) { clearTimeout(timer); this.pending.delete(id); reject(e); }
    });
  }
  stop(): Promise<void> {
    if (this.stopping) return this.stopping;
    this.stopping = this.stopProcess();
    return this.stopping;
  }
  private signal(signal: NodeJS.Signals): void {
    if (!this.child.pid || this.closed) return;
    try {
      if (process.platform !== "win32") process.kill(-this.child.pid, signal);
      else if (!this.closed) this.child.kill(signal);
    } catch (e: any) { if (e.code !== "ESRCH") throw e; }
  }
  private async stopProcess(): Promise<void> {
    this.rejectPending(new Error("RPC process stopping"));
    if (this.closed) return;
    // stdin EOF requests graceful Pi disposal; signals also stop child tool processes.
    if (!this.child.stdin.destroyed && this.child.stdin.writable) {
      try { this.child.stdin.end(); } catch {}
    }
    const delay = (ms: number) => new Promise<void>(r => {
      if (this.closed) return r();
      const t = setTimeout(r, ms);
      this.exitPromise.then(() => { clearTimeout(t); r(); });
    });
    await delay(this.graceMs);
    if (this.closed) return;
    this.signal("SIGTERM");
    await delay(this.graceMs);
    if (this.closed) return;
    this.signal("SIGKILL");
    if (!this.closed) {
      await delay(this.graceMs);
      if (!this.closed) throw new Error("Could not confirm child process exit; continuation disabled");
    }
  }
}
