import {
  XjtuApiError,
  XjtuClient,
  type Course,
  type Lecture,
  type LectureVideo,
  type Semester,
  type XjtuTransport,
} from "@xjtu-lecture2ppt/xjtu-client";
import { BrowserWindow, net, session as electronSession, type IncomingMessage, type Session } from "electron";

import { log } from "./logger";
import { XjtuSessionStore } from "./xjtu-session-store";

const XJTU_HOME = "https://class.xjtu.edu.cn/user/courses#/?pageIndex=1";
const XJTU_PARTITION = "persist:xjtu-auth";

export interface XjtuAuthStatus {
  authenticated: boolean;
}

export class XjtuService {
  private readonly authSession: Session;
  private readonly client: XjtuClient;
  private readonly sessionStore: XjtuSessionStore;
  private sessionRestoreAttempted = false;
  private loginPromise?: Promise<XjtuAuthStatus>;

  constructor() {
    this.authSession = electronSession.fromPartition(XJTU_PARTITION);
    const transport: XjtuTransport = {
      fetch: (input, init) => this.authSession.fetch(input, init),
    };
    this.client = new XjtuClient(transport);
    this.sessionStore = new XjtuSessionStore();
  }

  async getAuthStatus(): Promise<XjtuAuthStatus> {
    if (!this.sessionRestoreAttempted) {
      this.sessionRestoreAttempted = true;
      await this.sessionStore.restore(this.authSession);
    }
    try {
      await this.client.getSemesters();
      await this.sessionStore.save(this.authSession);
      log("AUTH", "XJTU session valid");
      return { authenticated: true };
    } catch (error) {
      if (error instanceof XjtuApiError && error.code === "AUTH_REQUIRED") {
        await this.sessionStore.clear();
        log("AUTH", "XJTU session requires login");
        return { authenticated: false };
      }
      throw error;
    }
  }

  async login(parent?: BrowserWindow): Promise<XjtuAuthStatus> {
    if (this.loginPromise) return this.loginPromise;
    this.loginPromise = this.openLoginWindow(parent).finally(() => {
      this.loginPromise = undefined;
    });
    return this.loginPromise;
  }

  async logout(): Promise<void> {
    await this.sessionStore.clear();
    await this.authSession.clearStorageData();
    await this.authSession.clearCache();
    await this.authSession.cookies.flushStore();
    log("AUTH", "XJTU session cleared");
  }

  getSemesters(): Promise<Semester[]> {
    return this.client.getSemesters();
  }

  getCourses(semesterIds?: string[]): Promise<Course[]> {
    return this.client.getAllCourses(semesterIds);
  }

  getLectures(courseId: string): Promise<Lecture[]> {
    return this.client.getLectures(courseId);
  }

  async getLecture(courseId: string, activityId: string): Promise<Lecture> {
    const lecture = await this.client.getLecture(courseId, activityId);
    log("VIDEO", "Resolved lecture views", {
      count: lecture.videos.length,
      labels: lecture.videos.map((video) => video.viewType),
    });
    return lecture;
  }

  async resolveLectureVideo(courseId: string, activityId: string, videoId: string): Promise<LectureVideo> {
    const lecture = await this.getLecture(courseId, activityId);
    const video = lecture.videos.find((candidate) => candidate.id === videoId);
    if (!video) throw new XjtuApiError("INVALID_RESPONSE", "该视频视角已经不存在，请刷新课堂列表。");
    return video;
  }

  fetchAuthorizedMedia(input: string, init: RequestInit = {}): Promise<Response> {
    return new Promise<Response>((resolve, reject) => {
      const headers = Object.fromEntries(new Headers(init.headers).entries());
      const request = net.request({
        url: input,
        method: init.method ?? "GET",
        headers,
        session: this.authSession,
        credentials: "include",
        redirect: "follow",
        origin: "https://class.xjtu.edu.cn",
        referrerPolicy: "unsafe-url",
      });
      let responseMessage: IncomingMessage | undefined;
      let streamController: ReadableStreamDefaultController<Uint8Array> | undefined;
      let settled = false;

      const removeAbortListener = (): void => init.signal?.removeEventListener("abort", abortRequest);
      const abortRequest = (): void => request.abort();
      if (init.signal?.aborted) request.abort();
      else init.signal?.addEventListener("abort", abortRequest, { once: true });

      request.on("response", (incoming) => {
        responseMessage = incoming;
        const body = new ReadableStream<Uint8Array>({
          start(controller) {
            streamController = controller;
            incoming.on("data", (chunk) => controller.enqueue(Uint8Array.from(chunk)));
            incoming.on("end", () => {
              removeAbortListener();
              controller.close();
            });
            incoming.on("aborted", () => controller.error(new Error("Media response aborted")));
            incoming.on("error", (error) => controller.error(error));
          },
          cancel() {
            request.abort();
          },
        });
        const responseHeaders = new Headers();
        for (const [name, value] of Object.entries(incoming.headers)) {
          if (Array.isArray(value)) value.forEach((item) => responseHeaders.append(name, item));
          else responseHeaders.set(name, value);
        }
        settled = true;
        resolve(
          new Response(body, {
            status: incoming.statusCode,
            statusText: incoming.statusMessage,
            headers: responseHeaders,
          }),
        );
      });
      request.on("error", (error) => {
        removeAbortListener();
        if (!settled) reject(error);
        else streamController?.error(error);
      });
      request.on("close", () => {
        if (responseMessage) removeAbortListener();
      });
      request.end();
    });
  }

  private async openLoginWindow(parent?: BrowserWindow): Promise<XjtuAuthStatus> {
    const loginWindow = new BrowserWindow({
      parent,
      width: 1100,
      height: 780,
      minWidth: 820,
      minHeight: 600,
      title: "登录西交 - XJTU Lecture2PPT",
      webPreferences: {
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        session: this.authSession,
      },
    });

    loginWindow.webContents.on("will-navigate", (event, url) => {
      if (!isAllowedAuthUrl(url)) event.preventDefault();
    });
    loginWindow.webContents.setWindowOpenHandler(({ url }) => {
      if (!isAllowedAuthUrl(url)) return { action: "deny" };
      return {
        action: "allow",
        overrideBrowserWindowOptions: {
          webPreferences: {
            contextIsolation: true,
            nodeIntegration: false,
            sandbox: true,
            session: this.authSession,
          },
        },
      };
    });

    let finished = false;
    let validating = false;
    return new Promise<XjtuAuthStatus>((resolve) => {
      const finish = (status: XjtuAuthStatus): void => {
        if (finished) return;
        finished = true;
        resolve(status);
        if (!loginWindow.isDestroyed()) loginWindow.close();
      };
      const maybeFinish = async (url: string): Promise<void> => {
        if (finished || validating || !isAuthenticatedPageCandidate(url)) return;
        validating = true;
        try {
          const status = await this.getAuthStatus();
          if (status.authenticated) finish(status);
        } catch {
          // The CAS redirect may still be finishing; keep the login window open.
        } finally {
          validating = false;
        }
      };

      loginWindow.webContents.on("did-navigate", (_event, url) => void maybeFinish(url));
      loginWindow.webContents.on("did-navigate-in-page", (_event, url) => void maybeFinish(url));
      loginWindow.on("closed", () => finish({ authenticated: false }));
      void loginWindow.loadURL(XJTU_HOME);
    });
  }
}

function isAllowedAuthUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return (
      url.protocol === "https:" && (url.hostname === "xjtu.edu.cn" || url.hostname.endsWith(".xjtu.edu.cn"))
    );
  } catch {
    return false;
  }
}

function isAuthenticatedPageCandidate(value: string): boolean {
  try {
    const url = new URL(value);
    return (
      url.hostname === "class.xjtu.edu.cn" && url.pathname !== "/login" && !url.pathname.startsWith("/auth/")
    );
  } catch {
    return false;
  }
}
