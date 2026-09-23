import { buildQuestions, FINAL_QUESTION, readDimensions, makeVerdict, buildFinalPayload } from './rubric.mjs';
import { buildPayload } from './judge.mjs';

export function sampleAnswer(question, choice) {
  const options = Object.keys(question.criteria);
  return { type: 'choice', choice, confidence: 0.82,
    probabilities: Object.fromEntries(options.map(k => [k, k === choice ? 0.9 : 0.1 / (options.length - 1)])) };
}
export function demoResult() {
  const questions = buildQuestions();
  const picks = { fit: 'native', value: 'useful', substance: 'working', honesty: 'grounded', robotics: 'demo' };
  const first = { model: 'fixture / 非真实推理', answers: Object.fromEntries(Object.entries(picks).map(([k, v]) => [k, sampleAnswer(questions[k], v)])) };
  const final = { model: 'fixture / 非真实推理', answers: { tier: sampleAnswer(FINAL_QUESTION, '人上人') } };
  const repo = { fullName: '虚构示例 / jev-snack-bot', url: null, sha: 'demo', description: '一个让 Jev 选择零食、让现成控制器负责抓取的虚构小机器人。', totalFiles: 2, eligibleFiles: 2, excludedFiles: [],
    treeTruncated: false, failedFiles: [], sampledAt: new Date().toISOString(), files: [
      { path: 'README.md', url: null, totalLines: 3, excerpted: false, content: '1: # Jev Snack Bot（虚构示例）\n2: Jev 根据文字偏好选一个零食，现成控制器执行抓取。\n3: 仅为仿真玩具，尚无对照实验。' },
      { path: 'robot.py', url: null, totalLines: 3, excerpted: false, content: '1: # 展示用途的伪代码，不代表真实项目\n2: snack = jev.choice(preference, available_snacks)\n3: existing_controller.pick(snack)' },
    ] };
  const payload = buildPayload(repo);
  for (const [id, question] of Object.entries(payload.questions)) {
    if (id.endsWith('_source')) first.answers[id] = sampleAnswer(question, 'E1');
  }
  const dimensions = readDimensions(first);
  return { ...makeVerdict(dimensions, final), repo, demo: true, inferenceMs: null, batchCount: 1, mergeCalls: 0, calls: 2, stages: ['read', 'verdict'],
    payloads: [payload, buildFinalPayload(dimensions)], raw: [first, final] };
}
