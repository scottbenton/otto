import type { EventEmitter } from "node:events";

export type ProcessLike = Pick<EventEmitter, "on" | "off">;

export type ShutdownRegistration = {
  signal: Promise<void>;
  escalation: Promise<void>;
  dispose: () => void;
};

export function registerShutdown(options: {
  process: ProcessLike;
}): ShutdownRegistration {
  let disposed = false;
  let firstSignalSeen = false;

  let resolveSignal!: () => void;
  let resolveEscalation!: () => void;

  const signal = new Promise<void>((resolve) => {
    resolveSignal = resolve;
  });
  const escalation = new Promise<void>((resolve) => {
    resolveEscalation = resolve;
  });

  const onSignal = (): void => {
    if (!firstSignalSeen) {
      firstSignalSeen = true;
      resolveSignal();
    } else {
      resolveEscalation();
    }
  };

  options.process.on("SIGINT", onSignal);
  options.process.on("SIGTERM", onSignal);

  return {
    signal,
    escalation,
    dispose(): void {
      if (disposed) return;
      disposed = true;
      options.process.off("SIGINT", onSignal);
      options.process.off("SIGTERM", onSignal);
    },
  };
}
