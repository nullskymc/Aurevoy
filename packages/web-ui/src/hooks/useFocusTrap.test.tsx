// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";
import { getFocusableElements, useFocusTrap } from "./useFocusTrap";

let root: ReturnType<typeof createRoot> | undefined;

function Harness({ open }: { open: boolean }) {
  const ref = useFocusTrap<HTMLElement>(open);
  return open ? (
    <section ref={ref} tabIndex={-1}>
      <button type="button">First</button>
      <button type="button">Last</button>
    </section>
  ) : null;
}

afterEach(() => {
  act(() => root?.unmount());
  root = undefined;
  document.body.innerHTML = "";
});

describe("useFocusTrap", () => {
  it("cycles Tab inside a modal and restores the opener focus", () => {
    const opener = document.createElement("button");
    document.body.appendChild(opener);
    opener.focus();
    const host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);

    act(() => root?.render(<Harness open />));
    const buttons = Array.from(host.querySelectorAll("button"));
    expect(document.activeElement).toBe(buttons[0]);

    buttons[1]?.focus();
    const tab = new KeyboardEvent("keydown", { key: "Tab", cancelable: true });
    act(() => document.dispatchEvent(tab));
    expect(tab.defaultPrevented).toBe(true);
    expect(document.activeElement).toBe(buttons[0]);

    buttons[0]?.focus();
    const reverseTab = new KeyboardEvent("keydown", { key: "Tab", shiftKey: true, cancelable: true });
    act(() => document.dispatchEvent(reverseTab));
    expect(reverseTab.defaultPrevented).toBe(true);
    expect(document.activeElement).toBe(buttons[1]);

    act(() => root?.render(<Harness open={false} />));
    expect(document.activeElement).toBe(opener);
  });

  it("ignores hidden controls when finding focus targets", () => {
    const container = document.createElement("div");
    container.innerHTML = '<button hidden>Hidden</button><button>Visible</button>';
    document.body.appendChild(container);
    expect(getFocusableElements(container).map((element) => element.textContent)).toEqual(["Visible"]);
  });
});
