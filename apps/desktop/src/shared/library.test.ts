import { describe, expect, it } from "vitest";

import type { PptLibraryItem } from "./app-contract";
import { groupPptLibraryByCourse, parseLibraryFileName, filterPptLibraryItems } from "./library";

describe("PPT library course grouping", () => {
  it("extracts the course name and lecture date from generated filenames", () => {
    expect(parseLibraryFileName("病理生理学_2026-09-15_第05讲_教师视角.pptx")).toEqual({
      course: "病理生理学",
      lectureDate: "2026-09-15",
    });
    expect(parseLibraryFileName("医学_伦理学_2026-09-16_第06讲_视角1.pptx")).toEqual({
      course: "医学_伦理学",
      lectureDate: "2026-09-16",
    });
  });

  it("keeps files from different courses in separate groups", () => {
    const base = {
      size: 1,
      createdAt: "2026-08-21T00:00:00.000Z",
      updatedAt: "2026-08-21T00:00:00.000Z",
    };
    const items: PptLibraryItem[] = [
      { ...base, path: "a.pptx", fileName: "a.pptx", course: "病理生理学" },
      { ...base, path: "b.pptx", fileName: "b.pptx", course: "内科学" },
      { ...base, path: "c.pptx", fileName: "c.pptx", course: "病理生理学" },
    ];

    expect(groupPptLibraryByCourse(items)).toEqual([
      { course: "病理生理学", items: [items[0], items[2]] },
      { course: "内科学", items: [items[1]] },
    ]);
  });
  it("filters items by filename without case sensitivity", () => {
    const base = {
      size: 1,
      createdAt: "2026-08-21T00:00:00.000Z",
      updatedAt: "2026-08-21T00:00:00.000Z",
    };

    const items: PptLibraryItem[] = [
      {
        ...base,
        path: "lecture-one.pptx",
        fileName: "Pathology_Lecture_01.pptx",
        course: "病理生理学",
      },
      {
        ...base,
        path: "lecture-two.pptx",
        fileName: "InternalMedicine_Class_02.pptx",
        course: "内科学",
      },
    ];

    expect(filterPptLibraryItems(items, "LECTURE")).toEqual([items[0]]);
    expect(filterPptLibraryItems(items, "  ")).toEqual(items);
  });
});
