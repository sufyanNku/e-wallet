const queue: Array<() => void> = [];
let active = 0;
export async function withRpcSlot<T>(task: () => Promise<T>): Promise<T> {
  if (active >= 3) {
    if (queue.length >= 128) throw new Error("RPC queue exceeds policy");
    await new Promise<void>((resolve) => queue.push(resolve));
  } else active++;
  try {
    return await task();
  } finally {
    const next = queue.shift();
    if (next) next();
    else active--;
  }
}
