import type { Queue } from "bullmq";

/**
 * Prefer BullMQ when a worker is online. If Redis is down OR no workers
 * are connected (common on single-service Railway), run the job inline
 * so merchants never get stuck on "Scan running" forever.
 */
export async function enqueueOrRunInline<T>(options: {
  queue: Queue;
  jobName: string;
  data: T;
  runInline: () => Promise<void>;
  label: string;
}): Promise<"queued" | "inline"> {
  const { queue, jobName, data, runInline, label } = options;

  try {
    const workers = await queue.getWorkers();
    if (workers.length > 0) {
      await queue.add(jobName, data as never);
      return "queued";
    }
    console.warn(
      `[${label}] No workers are connected; running inline`,
    );
  } catch (error) {
    console.warn(`[${label}] Queue unavailable; running inline`, error);
  }

  // Fire-and-forget so the HTTP response can redirect to the progress/scan
  // page immediately. Errors are logged; job status is updated by the runner.
  void runInline().catch((error) => {
    console.error(`[${label}] Inline run failed`, error);
  });
  return "inline";
}
