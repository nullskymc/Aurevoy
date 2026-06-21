import { useState } from "react";
import type { Project } from "@aurevoy/shared";

export function useProjects() {
  const [projects, setProjects] = useState<Project[]>([]);
  return { projects, setProjects };
}
