import type { Course, Lecture, Semester } from "@xjtu-lecture2ppt/xjtu-client";
import { useEffect, useMemo, useState } from "react";

import type { IpcResult } from "../../preload";
import type { AppSettings, PptLibraryItem, UpdateAppSettings } from "../../shared/app-contract";
import { filterPptLibraryItems, groupPptLibraryByCourse, type PptLibraryGroup } from "../../shared/library";
import type { PipelineJobSnapshot } from "../../shared/pipeline-contract";

const sections = ["课程", "任务", "PPT Library", "设置"] as const;
type Section = (typeof sections)[number];

export function App(): React.JSX.Element {
  const [activeSection, setActiveSection] = useState<Section>("课程");
  const [authenticated, setAuthenticated] = useState(false);
  const [semesters, setSemesters] = useState<Semester[]>([]);
  const [selectedSemesterId, setSelectedSemesterId] = useState("");
  const [courses, setCourses] = useState<Course[]>([]);
  const [lectureCounts, setLectureCounts] = useState<Record<string, number>>({});
  const [selectedCourse, setSelectedCourse] = useState<Course>();
  const [lectures, setLectures] = useState<Lecture[]>([]);
  const [selectedLecture, setSelectedLecture] = useState<Lecture>();
  const [selectedVideoKey, setSelectedVideoKey] = useState("");
  const [jobs, setJobs] = useState<PipelineJobSnapshot[]>([]);
  const [library, setLibrary] = useState<PptLibraryItem[]>([]);
  const [settings, setSettings] = useState<AppSettings>();
  const [busy, setBusy] = useState(true);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");

  const selectedVideo = useMemo(
    () => selectedLecture?.videos.find((video, index) => (video.id ?? `index-${index}`) === selectedVideoKey),
    [selectedLecture, selectedVideoKey],
  );
  const activeJob = useMemo(() => jobs.find((job) => !isTerminal(job.status)), [jobs]);
  const selectedJob = useMemo(
    () =>
      jobs.find(
        (job) =>
          job.courseId === selectedCourse?.id &&
          job.activityId === selectedLecture?.id &&
          job.videoId === selectedVideo?.id,
      ),
    [jobs, selectedCourse, selectedLecture, selectedVideo],
  );
  const groupedLibrary = useMemo(() => groupPptLibraryByCourse(library), [library]);

  useEffect(() => {
    window.lecture2ppt.pipeline.onUpdate((snapshot) => {
      setJobs((current) => upsertJob(current, snapshot));
    });
    void initialize();
    return () => window.lecture2ppt.pipeline.clearUpdateListener();
    // Initialization runs once per renderer lifetime.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function initialize(): Promise<void> {
    setBusy(true);
    setError("");
    try {
      const [loadedSettings, loadedJobs, status] = await Promise.all([
        window.lecture2ppt.settings.get().then(unwrap),
        window.lecture2ppt.pipeline.list().then(unwrap),
        window.lecture2ppt.xjtu.getStatus().then(unwrap),
      ]);
      setSettings(loadedSettings);
      setJobs(loadedJobs);
      setAuthenticated(status.authenticated);
      if (status.authenticated) await loadCatalog(loadedSettings.defaultSemesterId);
    } catch (caught) {
      setError(messageOf(caught));
    } finally {
      setBusy(false);
    }
  }

  async function loadCatalog(preferredSemesterId?: string): Promise<void> {
    const loadedSemesters = unwrap(await window.lecture2ppt.xjtu.getSemesters());
    setSemesters(loadedSemesters);
    const preferred = loadedSemesters.find((semester) => semester.id === preferredSemesterId);
    const current = [...loadedSemesters].filter((semester) => semester.isCurrent).sort(newestFirst)[0];
    const chosen = preferred ?? current ?? [...loadedSemesters].sort(newestFirst)[0];
    if (!chosen) {
      setCourses([]);
      setNotice("当前账号没有可用学期。");
      return;
    }
    setSelectedSemesterId(chosen.id);
    await loadCourses(chosen.id);
  }

  async function loadCourses(semesterId: string): Promise<void> {
    const loadedCourses = unwrap(await window.lecture2ppt.xjtu.getCourses([semesterId]));
    setCourses(loadedCourses);
    setSelectedCourse(undefined);
    setLectures([]);
    setSelectedLecture(undefined);
    setSelectedVideoKey("");
    setLectureCounts({});
    void loadLectureCounts(loadedCourses);
  }

  async function loadLectureCounts(items: Course[]): Promise<void> {
    const queue = [...items];
    const worker = async (): Promise<void> => {
      for (;;) {
        const course = queue.shift();
        if (!course) return;
        const result = await window.lecture2ppt.xjtu.getLectures(course.id);
        if (result.ok) {
          setLectureCounts((current) => ({ ...current, [course.id]: result.value.length }));
        }
      }
    };
    await Promise.all([worker(), worker()]);
  }

  async function login(): Promise<void> {
    await runBusy(async () => {
      const status = unwrap(await window.lecture2ppt.xjtu.login());
      setAuthenticated(status.authenticated);
      if (status.authenticated) await loadCatalog(settings?.defaultSemesterId);
    });
  }

  async function logout(): Promise<void> {
    await runBusy(async () => {
      unwrap(await window.lecture2ppt.xjtu.logout());
      setAuthenticated(false);
      setSemesters([]);
      setCourses([]);
      setLectures([]);
      setSelectedCourse(undefined);
      setSelectedLecture(undefined);
    });
  }

  async function selectCourse(course: Course): Promise<void> {
    await runBusy(async () => {
      setSelectedCourse(course);
      setSelectedLecture(undefined);
      setSelectedVideoKey("");
      const loaded = unwrap(await window.lecture2ppt.xjtu.getLectures(course.id));
      setLectures(loaded);
      setLectureCounts((current) => ({ ...current, [course.id]: loaded.length }));
    });
  }

  async function selectLecture(lecture: Lecture): Promise<void> {
    if (!selectedCourse) return;
    await runBusy(async () => {
      const detail = unwrap(await window.lecture2ppt.xjtu.getLecture(selectedCourse.id, lecture.id));
      setSelectedLecture(detail);
      setSelectedVideoKey(detail.videos[0]?.id ?? (detail.videos.length ? "index-0" : ""));
    });
  }

  async function startPipeline(): Promise<void> {
    if (!selectedCourse || !selectedLecture || !selectedVideo?.id) {
      setError("请先选择一个包含有效视频 ID 的课堂视角。");
      return;
    }
    await runBusy(async () => {
      const title = [
        selectedCourse.name,
        formatDateForTitle(selectedLecture.startTime),
        selectedLecture.title,
        selectedVideo.displayName,
      ]
        .filter(Boolean)
        .join("_");
      const started = unwrap(
        await window.lecture2ppt.pipeline.start({
          courseId: selectedCourse.id,
          activityId: selectedLecture.id,
          videoId: selectedVideo.id!,
          title,
          options: { captureIntervalSeconds: 3, maxSlides: 256 },
        }),
      );
      setJobs((current) => upsertJob(current, started));
      setActiveSection("任务");
      setNotice("任务已创建。应用会在确认 PPTX 有效后再清理临时视频。");
    });
  }

  async function refreshJobs(): Promise<void> {
    await runBusy(async () => setJobs(unwrap(await window.lecture2ppt.pipeline.list())));
  }

  async function cancelJob(jobId: string): Promise<void> {
    await runBusy(async () => {
      const updated = unwrap(await window.lecture2ppt.pipeline.cancel(jobId));
      setJobs((current) => upsertJob(current, updated));
    });
  }

  async function retryJob(jobId: string): Promise<void> {
    await runBusy(async () => {
      const updated = unwrap(await window.lecture2ppt.pipeline.retry(jobId));
      setJobs((current) => upsertJob(current, updated));
    });
  }

  async function deleteJobTemporaryFiles(jobId: string): Promise<void> {
    if (!window.confirm("确认删除该失败任务保留的视频和临时帧吗？此操作无法撤销。")) return;
    await runBusy(async () => {
      const updated = unwrap(await window.lecture2ppt.pipeline.deleteTemporaryFiles(jobId));
      setJobs((current) => upsertJob(current, updated));
      setNotice("临时文件已删除。");
    });
  }

  async function loadLibrary(): Promise<void> {
    await runBusy(async () => setLibrary(unwrap(await window.lecture2ppt.library.list())));
  }

  async function libraryAction(action: "open" | "reveal", path: string): Promise<void> {
    await runBusy(async () => unwrap(await window.lecture2ppt.library[action](path)));
  }

  async function deleteLibraryItem(item: PptLibraryItem): Promise<void> {
    if (!window.confirm(`确认永久删除“${item.fileName}”吗？`)) return;
    await runBusy(async () => {
      unwrap(await window.lecture2ppt.library.delete(item.path));
      setLibrary((current) => current.filter((candidate) => candidate.path !== item.path));
    });
  }

  async function updateSettings(update: UpdateAppSettings): Promise<void> {
    await runBusy(async () => setSettings(unwrap(await window.lecture2ppt.settings.update(update))));
  }

  async function chooseOutputDirectory(): Promise<void> {
    await runBusy(async () => {
      const chosen = unwrap(await window.lecture2ppt.settings.chooseOutputDirectory());
      if (chosen) setSettings(chosen);
    });
  }

  async function cleanupOrphans(): Promise<void> {
    await runBusy(async () => {
      const result = unwrap(await window.lecture2ppt.settings.cleanupOrphans());
      setNotice(
        result.removedDirectories
          ? `已清理 ${result.removedDirectories} 个过期任务目录，释放 ${formatBytes(result.reclaimedBytes)}。`
          : "没有发现需要清理的过期临时目录。",
      );
    });
  }

  async function runBusy(operation: () => Promise<void>): Promise<void> {
    setBusy(true);
    setError("");
    setNotice("");
    try {
      await operation();
    } catch (caught) {
      setError(messageOf(caught));
    } finally {
      setBusy(false);
    }
  }

  function switchSection(section: Section): void {
    setActiveSection(section);
    setError("");
    setNotice("");
    if (section === "任务") void refreshJobs();
    if (section === "PPT Library") void loadLibrary();
  }

  return (
    <div className="app-shell">
      <aside>
        <div className="brand-mark">L2P</div>
        <h1>XJTU Lecture2PPT</h1>
        <p className="subtitle">西交课堂回放整理工具</p>
        <nav aria-label="主导航">
          {sections.map((section) => (
            <button
              className={activeSection === section ? "active" : ""}
              key={section}
              onClick={() => switchSection(section)}
              type="button"
            >
              {section}
            </button>
          ))}
        </nav>
        <div className="runtime">Electron {window.lecture2ppt.versions.electron}</div>
      </aside>

      <main className="workspace">
        <PageHeader
          authenticated={authenticated}
          busy={busy}
          onLogin={() => void login()}
          onLogout={() => void logout()}
          section={activeSection}
        />
        {error && <div className="message error-message">{error}</div>}
        {notice && <div className="message notice-message">{notice}</div>}

        {activeSection === "课程" && (
          <CoursePage
            activeJob={activeJob}
            authenticated={authenticated}
            busy={busy}
            courses={courses}
            lectureCounts={lectureCounts}
            lectures={lectures}
            onGenerate={() => void startPipeline()}
            onRefresh={() => void loadCourses(selectedSemesterId)}
            onSelectCourse={(course) => void selectCourse(course)}
            onSelectLecture={(lecture) => void selectLecture(lecture)}
            onSelectSemester={(semesterId) => {
              setSelectedSemesterId(semesterId);
              void runBusy(() => loadCourses(semesterId));
            }}
            onSelectVideo={setSelectedVideoKey}
            selectedCourse={selectedCourse}
            selectedJob={selectedJob}
            selectedLecture={selectedLecture}
            selectedSemesterId={selectedSemesterId}
            selectedVideoKey={selectedVideoKey}
            semesters={semesters}
          />
        )}
        {activeSection === "任务" && (
          <TasksPage
            busy={busy}
            jobs={jobs}
            onCancel={(id) => void cancelJob(id)}
            onDeleteTemporary={(id) => void deleteJobTemporaryFiles(id)}
            onOpen={(path) => void libraryAction("open", path)}
            onRefresh={() => void refreshJobs()}
            onRetry={(id) => void retryJob(id)}
            onReveal={(path) => void libraryAction("reveal", path)}
          />
        )}
        {activeSection === "PPT Library" && (
          <LibraryPage
            busy={busy}
            groups={groupedLibrary}
            onDelete={(item) => void deleteLibraryItem(item)}
            onOpen={(path) => void libraryAction("open", path)}
            onOpenDirectory={() =>
              void runBusy(async () => unwrap(await window.lecture2ppt.library.openDirectory()))
            }
            onRefresh={() => void loadLibrary()}
            onReveal={(path) => void libraryAction("reveal", path)}
          />
        )}
        {activeSection === "设置" && settings && (
          <SettingsPage
            authenticated={authenticated}
            busy={busy}
            onChooseOutput={() => void chooseOutputDirectory()}
            onCleanup={() => void cleanupOrphans()}
            onLogin={() => void login()}
            onLogout={() => void logout()}
            onUpdate={(update) => void updateSettings(update)}
            semesters={semesters}
            settings={settings}
          />
        )}
      </main>
    </div>
  );
}

function PageHeader(props: {
  section: Section;
  authenticated: boolean;
  busy: boolean;
  onLogin(): void;
  onLogout(): void;
}): React.JSX.Element {
  return (
    <header>
      <div>
        <p className="eyebrow">XJTU LECTURE WORKSPACE</p>
        <h2>{props.section}</h2>
      </div>
      <div className="header-actions">
        <span className={`auth-badge ${props.authenticated ? "online" : "offline"}`}>
          西交：{props.authenticated ? "已登录" : "未登录"}
        </span>
        <button
          className="secondary-button"
          disabled={props.busy}
          onClick={props.authenticated ? props.onLogout : props.onLogin}
          type="button"
        >
          {props.authenticated ? "注销" : "登录西交"}
        </button>
      </div>
    </header>
  );
}

function CoursePage(props: {
  authenticated: boolean;
  busy: boolean;
  semesters: Semester[];
  selectedSemesterId: string;
  courses: Course[];
  lectureCounts: Record<string, number>;
  selectedCourse?: Course;
  lectures: Lecture[];
  selectedLecture?: Lecture;
  selectedVideoKey: string;
  selectedJob?: PipelineJobSnapshot;
  activeJob?: PipelineJobSnapshot;
  onSelectSemester(id: string): void;
  onRefresh(): void;
  onSelectCourse(course: Course): void;
  onSelectLecture(lecture: Lecture): void;
  onSelectVideo(key: string): void;
  onGenerate(): void;
}): React.JSX.Element {
  if (!props.authenticated) {
    return (
      <section className="empty-state">
        <span className="status-dot" aria-hidden="true" />
        <div>
          <h3>登录后读取课程</h3>
          <p>账号密码只在西交统一身份认证窗口中输入，应用不会读取或保存明文密码。</p>
        </div>
      </section>
    );
  }
  return (
    <>
      <div className="toolbar">
        <label>
          学期
          <select
            disabled={props.busy}
            onChange={(event) => props.onSelectSemester(event.target.value)}
            value={props.selectedSemesterId}
          >
            {props.semesters.map((semester) => (
              <option key={semester.id} value={semester.id}>
                {semester.name}
                {semester.isCurrent ? "（当前）" : ""}
              </option>
            ))}
          </select>
        </label>
        <button className="secondary-button" disabled={props.busy} onClick={props.onRefresh} type="button">
          刷新
        </button>
        {props.busy && <span className="loading-label">正在加载…</span>}
      </div>
      <div className="course-layout">
        <section className="course-list" aria-label="课程列表">
          {props.courses.map((course) => (
            <button
              className={`course-card ${props.selectedCourse?.id === course.id ? "selected" : ""}`}
              key={course.id}
              onClick={() => props.onSelectCourse(course)}
              type="button"
            >
              <strong>{course.name}</strong>
              <span>{course.teacher || course.instructors.join("、") || "教师信息未提供"}</span>
              <small>已上传课堂：{props.lectureCounts[course.id] ?? "…"}</small>
            </button>
          ))}
        </section>
        <section className="lecture-panel">
          {!props.selectedCourse ? (
            <div className="panel-placeholder">请选择一门课程</div>
          ) : (
            <>
              <div className="panel-title">
                <div>
                  <h3>{props.selectedCourse.name}</h3>
                  <p>{props.selectedCourse.teacher || props.selectedCourse.instructors.join("、")}</p>
                </div>
                <span>{props.lectures.length} 次回放</span>
              </div>
              <div className="lecture-list">
                {props.lectures.length === 0 && <div className="panel-placeholder">该课程尚未上传回放</div>}
                {props.lectures.map((lecture) => (
                  <article
                    className={`lecture-card ${props.selectedLecture?.id === lecture.id ? "selected" : ""}`}
                    key={lecture.id}
                  >
                    <button onClick={() => props.onSelectLecture(lecture)} type="button">
                      <span>
                        <strong>{lecture.title}</strong>
                        <small>
                          {formatDate(lecture.startTime)} · {formatDuration(lecture.duration)}
                        </small>
                      </span>
                      <span>选择视角</span>
                    </button>
                    {props.selectedLecture?.id === lecture.id && (
                      <div className="video-options">
                        <p className="view-count">发现 {props.selectedLecture.videos.length} 个视频视角</p>
                        {props.selectedLecture.videos.length === 0 && <p>该节课堂尚未上传视频。</p>}
                        {props.selectedLecture.videos.map((video, index) => {
                          const key = video.id ?? `index-${index}`;
                          return (
                            <label key={key}>
                              <input
                                checked={props.selectedVideoKey === key}
                                name="lecture-view"
                                onChange={() => props.onSelectVideo(key)}
                                type="radio"
                              />
                              <span>
                                {video.displayName || `视角 ${index + 1}`}
                                <small>
                                  {[video.resolution, video.streamType.toUpperCase()]
                                    .filter(Boolean)
                                    .join(" · ")}
                                </small>
                              </span>
                            </label>
                          );
                        })}
                        {props.selectedJob && <CompactJobProgress job={props.selectedJob} />}
                        <button
                          className="primary-button"
                          disabled={
                            props.busy ||
                            !props.selectedVideoKey ||
                            Boolean(props.activeJob) ||
                            props.selectedJob?.status === "completed"
                          }
                          onClick={props.onGenerate}
                          type="button"
                        >
                          {props.activeJob ? "已有任务正在运行" : "生成 PDF + TXT"}
                        </button>
                      </div>
                    )}
                  </article>
                ))}
              </div>
            </>
          )}
        </section>
      </div>
    </>
  );
}

function TasksPage(props: {
  jobs: PipelineJobSnapshot[];
  busy: boolean;
  onRefresh(): void;
  onCancel(id: string): void;
  onRetry(id: string): void;
  onDeleteTemporary(id: string): void;
  onOpen(path: string): void;
  onReveal(path: string): void;
}): React.JSX.Element {
  return (
    <section className="page-stack">
      <div className="page-toolbar">
        <p>任务会保存在本机，应用重启后仍可查看并恢复。</p>
        <button className="secondary-button" disabled={props.busy} onClick={props.onRefresh} type="button">
          刷新
        </button>
      </div>
      {props.jobs.length === 0 ? (
        <div className="empty-state">
          <div>
            <h3>暂无任务</h3>
            <p>在课程页面选择课堂视角后创建任务。</p>
          </div>
        </div>
      ) : (
        <div className="task-list">
          {props.jobs.map((job) => (
            <article className={`task-card ${job.status}`} key={job.id}>
              <div className="task-heading">
                <div>
                  <strong>{job.title}</strong>
                  <small>{formatDate(job.createdAt)}</small>
                </div>
                <span className="status-pill">{jobStatusText(job)}</span>
              </div>
              <CompactJobProgress job={job} />
              {job.error && <p className="task-error">{job.error}</p>}
              {job.pdfPath && <p className="file-path">PDF：{job.pdfPath}</p>}
              {job.textPath && <p className="file-path">TXT：{job.textPath}</p>}
              {job.temporaryFilesDeletedAt && <p className="success-text">失败任务的临时文件已手动删除。</p>}
              <div className="card-actions">
                {!isTerminal(job.status) && (
                  <button className="secondary-button" onClick={() => props.onCancel(job.id)} type="button">
                    取消
                  </button>
                )}
                {(job.status === "failed" || job.status === "cancelled") && !job.temporaryFilesDeletedAt && (
                  <button className="primary-button" onClick={() => props.onRetry(job.id)} type="button">
                    重新处理
                  </button>
                )}
                {(job.status === "failed" || job.status === "cancelled") && !job.temporaryFilesDeletedAt && (
                  <button
                    className="danger-button"
                    onClick={() => props.onDeleteTemporary(job.id)}
                    type="button"
                  >
                    删除临时文件
                  </button>
                )}
                {(job.pdfPath || job.outputPath) && (
                  <button
                    className="secondary-button"
                    onClick={() => props.onOpen(job.pdfPath || job.outputPath!)}
                    type="button"
                  >
                    打开 PDF
                  </button>
                )}
                {job.textPath && (
                  <button
                    className="secondary-button"
                    onClick={() => props.onOpen(job.textPath!)}
                    type="button"
                  >
                    打开 TXT
                  </button>
                )}
                {(job.pdfPath || job.outputPath) && (
                  <button
                    className="secondary-button"
                    onClick={() => props.onReveal(job.pdfPath || job.outputPath!)}
                    type="button"
                  >
                    显示位置
                  </button>
                )}
              </div>
            </article>
          ))}
        </div>
      )}
    </section>
  );
}

function LibraryPage(props: {
  groups: PptLibraryGroup[];
  busy: boolean;
  onRefresh(): void;
  onOpenDirectory(): void;
  onOpen(path: string): void;
  onReveal(path: string): void;
  onDelete(item: PptLibraryItem): void;
}): React.JSX.Element {
  const [searchQuery, setSearchQuery] = useState("");
  const visibleGroups = useMemo(
    () =>
      groupPptLibraryByCourse(
        filterPptLibraryItems(
          props.groups.flatMap((group) => group.items),
          searchQuery,
        ),
      ),
    [props.groups, searchQuery],
  );

  return (
    <section className="page-stack">
      <div className="page-toolbar">
        <p>PDF 和 TXT 按课程成对管理。</p>
        <input
          aria-label="搜索输出文件名"
          className="library-search-input"
          onChange={(event) => setSearchQuery(event.target.value)}
          placeholder="搜索文件名"
          type="search"
          value={searchQuery}
        />
        <div className="card-actions">
          <button className="secondary-button" onClick={props.onOpenDirectory} type="button">
            打开输出目录
          </button>
          <button className="secondary-button" disabled={props.busy} onClick={props.onRefresh} type="button">
            刷新
          </button>
        </div>
      </div>
      {visibleGroups.length === 0 ? (
        <div className="empty-state">
          <div>
            <h3>{searchQuery.trim() ? "没有匹配的文件" : "资料库为空"}</h3>
            <p>
              {searchQuery.trim() ? "请尝试其他文件名关键词。" : "成功生成的 PDF 和 TXT 会自动显示在这里。"}
            </p>
          </div>
        </div>
      ) : (
        <div className="library-groups">
          {visibleGroups.map((group) => (
            <section className="library-group" key={group.course}>
              <div className="library-group-heading">
                <h3>{group.course}</h3>
                <span>{group.items.length} 组文件</span>
              </div>
              <div className="library-table">
                <div className="library-row library-head">
                  <span>日期</span>
                  <span>文件</span>
                  <span>大小</span>
                  <span>生成时间</span>
                  <span>操作</span>
                </div>
                {group.items.map((item) => (
                  <div className="library-row" key={item.path}>
                    <span>{item.lectureDate || "未标注"}</span>
                    <strong title={`${item.pdfPath || item.path}\n${item.textPath || ""}`}>
                      {item.fileName}
                    </strong>
                    <span>
                      PDF {formatBytes(item.pdfSize ?? item.size)}
                      {item.textSize !== undefined ? ` · TXT ${formatBytes(item.textSize)}` : ""}
                    </span>
                    <span>{formatDate(item.createdAt)}</span>
                    <div className="row-actions">
                      <button onClick={() => props.onOpen(item.pdfPath || item.path)} type="button">
                        PDF
                      </button>
                      {item.textPath && (
                        <button onClick={() => props.onOpen(item.textPath!)} type="button">
                          TXT
                        </button>
                      )}
                      <button onClick={() => props.onReveal(item.pdfPath || item.path)} type="button">
                        位置
                      </button>
                      <button className="delete-link" onClick={() => props.onDelete(item)} type="button">
                        删除
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            </section>
          ))}
        </div>
      )}
    </section>
  );
}

function SettingsPage(props: {
  settings: AppSettings;
  semesters: Semester[];
  authenticated: boolean;
  busy: boolean;
  onLogin(): void;
  onLogout(): void;
  onChooseOutput(): void;
  onCleanup(): void;
  onUpdate(update: UpdateAppSettings): void;
}): React.JSX.Element {
  return (
    <section className="settings-grid">
      <article className="settings-card">
        <h3>西交登录</h3>
        <p>{props.authenticated ? "当前会话有效" : "尚未登录或会话已过期"}</p>
        <button
          className="secondary-button"
          disabled={props.busy}
          onClick={props.authenticated ? props.onLogout : props.onLogin}
          type="button"
        >
          {props.authenticated ? "注销" : "登录西交"}
        </button>
      </article>
      <article className="settings-card wide">
        <h3>PDF/TXT 输出目录</h3>
        <p className="file-path">{props.settings.outputDirectory}</p>
        <button className="secondary-button" onClick={props.onChooseOutput} type="button">
          选择目录
        </button>
      </article>
      <article className="settings-card">
        <label>
          默认学期
          <select
            value={props.settings.defaultSemesterId ?? ""}
            onChange={(event) => props.onUpdate({ defaultSemesterId: event.target.value })}
          >
            <option value="">自动识别当前学期</option>
            {props.semesters.map((semester) => (
              <option key={semester.id} value={semester.id}>
                {semester.name}
              </option>
            ))}
          </select>
        </label>
      </article>
      <article className="settings-card">
        <label>
          下载并发
          <select
            value={props.settings.downloadConcurrency}
            onChange={(event) => props.onUpdate({ downloadConcurrency: Number(event.target.value) as 1 | 2 })}
          >
            <option value={1}>1 个任务</option>
            <option value={2}>2 个任务</option>
          </select>
        </label>
        <p>转换并发固定为 1，避免长视频占满内存。</p>
      </article>
      <article className="settings-card">
        <label className="switch-row">
          <input
            checked={props.settings.autoDeleteSource}
            onChange={(event) => props.onUpdate({ autoDeleteSource: event.target.checked })}
            type="checkbox"
          />
          <span>转换成功后自动删除视频</span>
        </label>
        <label className="switch-row">
          <input
            checked={props.settings.retainFailedTemporaryFiles}
            onChange={(event) => props.onUpdate({ retainFailedTemporaryFiles: event.target.checked })}
            type="checkbox"
          />
          <span>保留失败任务临时文件</span>
        </label>
      </article>
      <article className="settings-card">
        <label>
          孤立临时文件保留天数
          <input
            min={1}
            max={365}
            type="number"
            value={props.settings.orphanRetentionDays}
            onChange={(event) => props.onUpdate({ orphanRetentionDays: Number(event.target.value) })}
          />
        </label>
        <button className="secondary-button" onClick={props.onCleanup} type="button">
          立即清理过期文件
        </button>
      </article>
    </section>
  );
}

function CompactJobProgress({ job }: { job: PipelineJobSnapshot }): React.JSX.Element {
  const percent = Math.max(0, Math.min(100, job.percent ?? 0));
  return (
    <div className={`job-progress ${job.status}`}>
      <div className="progress-heading">
        <strong>{jobStatusText(job)}</strong>
        <span>{Math.round(percent)}%</span>
      </div>
      <div className="progress-track">
        <span style={{ width: `${percent}%` }} />
      </div>
      <p>
        {job.status === "downloading"
          ? `${formatBytes(job.downloadedBytes ?? 0)}${job.totalBytes ? ` / ${formatBytes(job.totalBytes)}` : ""}`
          : job.capturedFrames
            ? `已提取 ${job.capturedFrames} 张有效幻灯片`
            : statusDetail(job)}
      </p>
    </div>
  );
}

function upsertJob(jobs: PipelineJobSnapshot[], job: PipelineJobSnapshot): PipelineJobSnapshot[] {
  const next = jobs.filter((candidate) => candidate.id !== job.id);
  next.push(job);
  return next.sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
}

function unwrap<T>(result: IpcResult<T>): T {
  if (!result.ok) throw new Error(result.error.message);
  return result.value;
}

function newestFirst(left: Semester, right: Semester): number {
  return right.sort - left.sort || Number(right.id) - Number(left.id);
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : "操作失败。";
}

function isTerminal(status: PipelineJobSnapshot["status"]): boolean {
  return status === "completed" || status === "failed" || status === "cancelled";
}

function jobStatusText(job: PipelineJobSnapshot): string {
  const labels: Record<PipelineJobSnapshot["status"], string> = {
    queued: "等待处理",
    authenticating: "检查登录",
    "resolving-video": "获取视频地址",
    downloading: "下载视频",
    downloaded: "下载完成",
    converting: "分析并提取关键帧",
    "converting-pdf": "转换 PDF",
    "recognizing-text": "OCR 识别文字",
    "writing-output": "写入 PDF/TXT",
    "writing-ppt": "处理旧版 PPT 任务",
    cleaning: "清理临时视频",
    completed: "已完成",
    failed: "失败",
    cancelled: "已取消",
  };
  return labels[job.status];
}

function statusDetail(job: PipelineJobSnapshot): string {
  if (job.status === "completed") {
    return job.sourceDeleted ? "PDF/TXT 已验证，临时视频已删除" : "PDF/TXT 已验证并保存";
  }
  if (job.status === "failed") return "原视频默认保留，可重新处理";
  if (job.status === "cancelled") return "任务已停止";
  return "任务状态会自动保存";
}

function formatDate(value?: string): string {
  if (!value) return "时间未提供";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString("zh-CN", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function formatDateForTitle(value?: string): string {
  if (!value) return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

function formatDuration(seconds?: number): string {
  return seconds === undefined ? "时长未提供" : `${Math.round(seconds / 60)} 分钟`;
}

function formatBytes(value: number): string {
  if (value < 1024) return `${value} B`;
  if (value < 1024 ** 2) return `${(value / 1024).toFixed(1)} KB`;
  if (value < 1024 ** 3) return `${(value / 1024 ** 2).toFixed(1)} MB`;
  return `${(value / 1024 ** 3).toFixed(2)} GB`;
}
