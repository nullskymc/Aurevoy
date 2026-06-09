import { useState } from "react";
import type { MemoryEntry } from "@aurevoy/shared";

export function useMemories() {
  const [memories, setMemories] = useState<MemoryEntry[]>([]);
  return { memories, setMemories };
}
