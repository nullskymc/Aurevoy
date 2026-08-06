/**
 * 跨进程契约的渐进式按域入口。
 *
 * 先提供稳定导入边界，再逐步把 index.ts 中的定义迁移到对应域文件，避免一次性改动所有消费者。
 */
export * from './projects.js';
export * from './runtime.js';
export * from './task.js';
export * from './tools.js';
