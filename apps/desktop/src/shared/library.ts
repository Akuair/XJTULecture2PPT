import type { PptLibraryItem } from "./app-contract";

export interface PptLibraryGroup {
  course: string;
  items: PptLibraryItem[];
}

export function parseLibraryFileName(fileName: string): {
  course: string;
  lectureDate?: string;
} {
  const stem = fileName.replace(/^.*[\\/]/, "").replace(/\.(?:pptx|pdf|txt)$/i, "");
  const parts = stem.split("_").filter(Boolean);
  const dateIndex = parts.findIndex((part) => /^\d{4}-\d{2}-\d{2}$/.test(part));
  return {
    course: (dateIndex > 0 ? parts.slice(0, dateIndex).join("_") : parts[0]) || "未分类课程",
    lectureDate: dateIndex >= 0 ? parts[dateIndex] : undefined,
  };
}

export function filterPptLibraryItems(items: PptLibraryItem[], query: string): PptLibraryItem[] {
  const normalizedQuery = query.trim().toLocaleLowerCase();

  if (!normalizedQuery) {
    return items;
  }

  return items.filter((item) => item.fileName.toLocaleLowerCase().includes(normalizedQuery));
}

export function groupPptLibraryByCourse(items: PptLibraryItem[]): PptLibraryGroup[] {
  const groups = new Map<string, PptLibraryItem[]>();
  for (const item of items) {
    const course = item.course?.trim() || "未分类课程";
    groups.set(course, [...(groups.get(course) ?? []), item]);
  }
  return [...groups.entries()]
    .map(([course, groupedItems]) => ({ course, items: groupedItems }))
    .sort((left, right) => left.course.localeCompare(right.course, "zh-CN"));
}
