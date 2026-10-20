import type { DesktopBridge } from "../../preload";

declare global {
  interface Window {
    lecture2ppt: DesktopBridge;
  }
}

export {};
