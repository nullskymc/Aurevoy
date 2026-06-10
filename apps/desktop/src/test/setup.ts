// Vitest 全局测试初始化：引入 jest-dom 自定义断言（toBeInTheDocument 等）。
import "@testing-library/jest-dom/vitest";

// jsdom 未实现滚动 API，组件副作用里会调用，提供 no-op 桩避免抛错。
if (!HTMLElement.prototype.scrollIntoView) {
  HTMLElement.prototype.scrollIntoView = () => {};
}
if (!Element.prototype.scrollTo) {
  Element.prototype.scrollTo = () => {};
}
