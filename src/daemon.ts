export type DaemonState = "created" | "starting" | "running" | "stopping" | "stopped";

export type LifecycleRuntime = {
  start: () => Promise<void>;
  stop: () => Promise<void>;
  beginShutdown?: () => Promise<void> | void;
  waitForIdle?: (options: { signal?: AbortSignal }) => Promise<void>;
};

export type StopOptions = {
  signal?: AbortSignal;
};

export type Daemon = {
  getState: () => DaemonState;
  start: () => Promise<void>;
  stop: (options?: StopOptions) => Promise<void>;
};

export function createDaemon(runtime: LifecycleRuntime): Daemon {
  let state: DaemonState = "created";
  let startPromise: Promise<void> | undefined;
  let stopPromise: Promise<void> | undefined;

  return {
    getState: () => state,

    start(): Promise<void> {
      if (state === "running" || state === "stopping" || state === "stopped") {
        return Promise.resolve();
      }
      if (startPromise !== undefined) {
        return startPromise;
      }

      state = "starting";
      startPromise = (async () => {
        try {
          await runtime.start();
          state = "running";
        } catch (err) {
          try {
            await runtime.stop();
          } finally {
            state = "stopped";
          }
          throw err;
        }
      })();

      return startPromise;
    },

    stop(options: StopOptions = {}): Promise<void> {
      if (state === "created" || state === "stopped") {
        state = "stopped";
        return Promise.resolve();
      }
      if (stopPromise !== undefined) {
        return stopPromise;
      }

      stopPromise = (async () => {
        try {
          if (state === "starting" && startPromise !== undefined) {
            await startPromise;
          }
          state = "stopping";
          await runtime.beginShutdown?.();
          await runtime.waitForIdle?.(
            options.signal !== undefined ? { signal: options.signal } : {},
          );
          await runtime.stop();
          state = "stopped";
        } catch (err) {
          state = "running";
          stopPromise = undefined;
          throw err;
        }
      })();

      return stopPromise;
    },
  };
}
