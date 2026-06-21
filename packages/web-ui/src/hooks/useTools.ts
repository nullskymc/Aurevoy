import { useState } from "react";
import type { ToolDescriptor } from "@aurevoy/shared";

export function useTools() {
  const [tools, setTools] = useState<ToolDescriptor[]>([]);
  return { tools, setTools };
}
