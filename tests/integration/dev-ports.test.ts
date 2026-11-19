import { it, expect } from "vitest";
import { createConnection, createServer } from "node:net";
import { once } from "node:events";
import { DevPorts } from "../../scripts/dev-ports";

it("releases a reserved port when an existing browser reconnects during startup", async () => {
  const ports = new DevPorts();
  const port = await ports.reserve(49152);
  const socket = createConnection({ host: "127.0.0.1", port });
  socket.on("error", () => {});
  let timeout: ReturnType<typeof setTimeout> | undefined;
  const next = createServer();
  try {
    await once(socket, "connect");
    socket.write("GET / HTTP/1.1\r\nHost: 127.0.0.1\r\n\r\n");
    await Promise.race([
      ports.release(port),
      new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(
          () => reject(new Error("Browser socket blocked startup")),
          2000,
        );
      }),
    ]);
    await new Promise<void>((resolve, reject) => {
      next.once("error", reject);
      next.listen(port, "127.0.0.1", resolve);
    });
    expect(next.listening).toBe(true);
  } finally {
    clearTimeout(timeout);
    socket.destroy();
    if (next.listening)
      await new Promise<void>((resolve) => next.close(() => resolve()));
    await ports.close();
  }
});
