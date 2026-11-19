import { createServer, type Server } from "node:net";

export function preferredPort(value: string | undefined, fallback: number) {
  const port = value === undefined ? fallback : Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65535)
    throw new Error("Development ports must be integers from 1 to 65535.");
  return port;
}

// Keep planned ports reserved until each child launches, so services in this
// stack cannot select each other's ports while configuration is assembled.
export class DevPorts {
  private reservations = new Map<number, Server>();

  async reserve(preferred: number) {
    preferredPort(String(preferred), preferred);
    for (let attempt = 0; attempt <= 100; attempt++) {
      // Ask the OS for a free port if the nearby range is full or exhausted.
      const port =
        attempt === 100 || preferred + attempt > 65535
          ? 0
          : preferred + attempt;
      if (this.reservations.has(port)) continue;
      // Browser auto-reconnects can reach a reserved port during setup. Never
      // retain those sockets: server.close() must finish before Vite can bind.
      const server = createServer((socket) => socket.destroy());
      const listening = await new Promise<boolean>((resolve, reject) => {
        server.once("error", (error: NodeJS.ErrnoException) => {
          if (["EADDRINUSE", "EACCES"].includes(error.code ?? ""))
            resolve(false);
          else reject(error);
        });
        server.listen(port, "127.0.0.1", () => resolve(true));
      });
      if (listening) {
        const address = server.address();
        if (!address || typeof address === "string")
          throw new Error("Development port did not bind.");
        this.reservations.set(address.port, server);
        return address.port;
      }
    }
    throw new Error("No available development port at or above " + preferred);
  }

  async release(port: number) {
    const server = this.reservations.get(port);
    if (!server) return;
    this.reservations.delete(port);
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }

  async close() {
    await Promise.all(
      [...this.reservations.keys()].map((port) => this.release(port)),
    );
  }
}
