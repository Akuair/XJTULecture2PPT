import type { Semester } from "./types";

export function selectActiveSemester(semesters: Semester[]): Semester | undefined {
  return semesters.filter((semester) => semester.isCurrent).sort(compareNewest)[0];
}

export function suggestMostRecentSemester(semesters: Semester[]): Semester | undefined {
  return [...semesters].sort(compareNewest)[0];
}

function compareNewest(left: Semester, right: Semester): number {
  return right.sort - left.sort || Number(right.id) - Number(left.id);
}
