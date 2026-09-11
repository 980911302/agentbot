import type { SeedAgent, SeedRoom } from './runtime.js';

/** 白泽系统的常驻成员；projectIds 决定它们能读到哪份项目笔记 */
export const SEED_AGENTS: SeedAgent[] = [
  {
    name: '测试运维',
    color: '#30d158',
    instructions: '负责测试部署与运维保障，核对 yaml 与 Redis 配置，管发测 checklist。',
    projectIds: ['白泽'],
  },
  {
    name: '知识库服务',
    color: '#5eead4',
    instructions: '知识库后台服务，处理 API 接口与用户认证 token。',
    projectIds: ['白泽'],
  },
  {
    name: '白泽团队',
    color: '#a855f7',
    instructions: '白泽系统核心团队，负责业务规则制定与统一发测。',
    projectIds: ['白泽'],
  },
  {
    name: 'AI服务',
    color: '#38bdf8',
    instructions: 'AI 推理与算法服务核心，负责模型调度与算法处理。',
    projectIds: ['白泽'],
  },
  {
    name: '知识库服务·备份',
    color: '#5eead4',
    instructions: '知识库服务的第二负责人，主备切换与数据一致性。',
    projectIds: ['白泽'],
  },
];

/** 预置房间；群只是成员表，成员最多 6 个 */
export const SEED_ROOMS: SeedRoom[] = [
  {
    name: '白泽联调',
    memberNames: ['测试运维', '知识库服务', '白泽团队', 'AI服务'],
  },
];
