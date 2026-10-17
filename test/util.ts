// Small helpers several test files used to define for themselves.

export const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

// One short turn of the event loop for queued work (timers, a settled promise chain) to run.
export const tick = () => sleep(5);

// A promise and the function that settles it, for holding a fake step open until the test says go.
export const defer = <T>() => {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => (resolve = r));
  return { promise, resolve };
};
