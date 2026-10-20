import { convertVideoUrlToPpt } from "@xjtu-lecture2ppt/video-to-ppt-core";

import type { ConversionWorkerBridge } from "../../preload/conversion";
import type { ConversionRendererTask } from "../../shared/conversion-contract";

declare global {
  interface Window {
    conversionWorker: ConversionWorkerBridge;
  }
}

let activeTaskId: string | undefined;
let controller: AbortController | undefined;

window.conversionWorker.onCancel((taskId) => {
  if (taskId === activeTaskId) controller?.abort();
});

window.conversionWorker.onTask((task) => void run(task));
window.conversionWorker.ready();

async function run(task: ConversionRendererTask): Promise<void> {
  if (activeTaskId) {
    window.conversionWorker.fail(task.id, "转换器当前已有任务正在运行。");
    return;
  }
  activeTaskId = task.id;
  controller = new AbortController();
  try {
    const result = await convertVideoUrlToPpt(
      task.mediaUrl,
      task.options,
      (progress) => window.conversionWorker.progress(task.id, progress),
      controller.signal,
    );
    window.conversionWorker.complete(task.id, result.pptx, {
      durationSeconds: result.durationSeconds,
      analyzedEndTimeSeconds: result.analyzedEndTimeSeconds,
      threshold: result.threshold,
      capturedFrameCount: result.capturedFrameCount,
    });
  } catch (error) {
    const message = controller.signal.aborted
      ? "视频转换已取消，已下载的视频仍然保留。"
      : error instanceof Error
        ? error.message
        : "视频转换失败，已下载的视频仍然保留。";
    window.conversionWorker.fail(task.id, message);
  } finally {
    activeTaskId = undefined;
    controller = undefined;
  }
}
