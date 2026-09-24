import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import { tempDataDir } from './fakes/test-env.js';
import { ModelConfigStore, maskApiKey } from '../src/storage/model-config-store.js';
import {
  MODEL_CATALOG,
  lookupModelThinkingInfo,
  STANDARD_THINKING_LEVELS,
} from '../src/shared/contracts/model-catalog.js';
import { OpenAIProvider } from '../src/llm/openai-provider.js';

describe('模型配置与思考模式', () => {
  it('ModelConfigStore: 默认开启思考模式并支持热读写持久化', async () => {
    const env = await tempDataDir('model-config-test');
    try {
      const store = new ModelConfigStore(env.dir);
      const loaded = await store.load({
        baseURL: 'https://api.deepseek.com/v1',
        apiKey: 'sk-12345678abcdefgh',
        model: 'deepseek-reasoner',
      });

      // 验证默认开启思考模式，默认中度思考
      assert.equal(loaded.thinkingEnabled, true);
      assert.equal(loaded.thinkingLevel, 'medium');
      assert.equal(loaded.model, 'deepseek-reasoner');

      // 更新保存为 o3-mini，思考等级设为 high
      const updated = await store.save({
        baseURL: 'https://api.openai.com/v1',
        model: 'o3-mini',
        thinkingEnabled: true,
        thinkingLevel: 'high',
      });

      assert.equal(updated.model, 'o3-mini');
      assert.equal(updated.thinkingLevel, 'high');
      assert.equal(updated.apiKey, 'sk-12345678abcdefgh');

      // 再次创建 store 实例验证从磁盘重新读取
      const store2 = new ModelConfigStore(env.dir);
      const reloaded = await store2.load();
      assert.equal(reloaded.model, 'o3-mini');
      assert.equal(reloaded.thinkingLevel, 'high');
      assert.equal(reloaded.thinkingEnabled, true);
    } finally {
      await env.cleanup();
    }
  });

  it('maskApiKey: 安全脱敏', () => {
    assert.equal(maskApiKey(''), '');
    assert.equal(maskApiKey('123456'), '****');
    assert.equal(maskApiKey('sk-abcdef1234567890'), 'sk-a••••7890');
  });

  it('lookupModelThinkingInfo: 准确查找与联想主流模型思考能力', () => {
    const o3 = lookupModelThinkingInfo('o3-mini');
    assert.equal(o3.supportsThinking, true);
    assert.equal(o3.parameterFormat, 'reasoning_effort');
    assert.equal(o3.defaultLevel, 'medium');

    const claude = lookupModelThinkingInfo('claude-3-7-sonnet');
    assert.equal(claude.supportsThinking, true);
    assert.equal(claude.parameterFormat, 'hybrid');
    assert.equal(claude.budgetMap?.high, 24576);

    const dsReasoner = lookupModelThinkingInfo('deepseek-reasoner');
    assert.equal(dsReasoner.supportsThinking, true);
    assert.equal(dsReasoner.parameterFormat, 'native_cot');

    const unknown = lookupModelThinkingInfo('custom-vllm-r1');
    assert.equal(unknown.supportsThinking, true);
    assert.equal(unknown.defaultLevel, 'medium');
  });

  it('OpenAIProvider: 正确注入 reasoning_effort 与 thinking 结构', async () => {
    let capturedBody: any = null;
    const originalFetch = globalThis.fetch;

    globalThis.fetch = (async (url: any, init: any) => {
      capturedBody = JSON.parse(init.body);
      return new Response(
        JSON.stringify({
          choices: [{ message: { role: 'assistant', content: 'hello' }, finish_reason: 'stop' }],
          usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    }) as any;

    try {
      const provider = new OpenAIProvider({
        apiKey: 'sk-test',
        model: 'o3-mini',
        thinkingEnabled: true,
        thinkingLevel: 'high',
      });

      const res = await provider.chat([{ role: 'user', content: 'test' }]);
      assert.equal(res.content, 'hello');
      assert.equal(capturedBody.model, 'o3-mini');
      assert.equal(capturedBody.reasoning_effort, 'high');
      assert.equal(capturedBody.thinking?.type, 'enabled');
      assert.equal(capturedBody.thinking?.budget_tokens, 24576);
      // o3-mini 不应传递非 1 的 temperature
      assert.equal(capturedBody.temperature, undefined);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('OpenAIProvider: 关闭思考模式时不携带 reasoning_effort', async () => {
    let capturedBody: any = null;
    const originalFetch = globalThis.fetch;

    globalThis.fetch = (async (url: any, init: any) => {
      capturedBody = JSON.parse(init.body);
      return new Response(
        JSON.stringify({
          choices: [{ message: { role: 'assistant', content: 'hello' }, finish_reason: 'stop' }],
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    }) as any;

    try {
      const provider = new OpenAIProvider({
        apiKey: 'sk-test',
        model: 'gpt-4o',
        thinkingEnabled: false,
      });

      await provider.chat([{ role: 'user', content: 'test' }]);
      assert.equal(capturedBody.reasoning_effort, undefined);
      assert.equal(capturedBody.thinking, undefined);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('OpenAIProvider: reasoning_content 不并进对话正文', async () => {
    const originalFetch = globalThis.fetch;

    globalThis.fetch = (async () => {
      return new Response(
        JSON.stringify({
          choices: [
            {
              message: {
                role: 'assistant',
                content: '答案是 42。',
                reasoning_content: '先推导宇宙的终极答案...',
              },
              finish_reason: 'stop',
            },
          ],
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    }) as any;

    try {
      const provider = new OpenAIProvider({
        apiKey: 'sk-test',
        model: 'deepseek-reasoner',
        thinkingEnabled: true,
      });

      const res = await provider.chat([{ role: 'user', content: 'test' }]);
      // 思维链只在模型侧观测：不包 <think>、不进正文，回复干净可复制
      assert.equal(res.content, '答案是 42。');
      assert.equal(res.content?.includes('先推导宇宙的终极答案'), false);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('ModelConfigStore: 支持多模型管理、增删改与一键切换当前模型', async () => {
    const env = await tempDataDir('multi-model-test');
    try {
      const store = new ModelConfigStore(env.dir);
      const initial = await store.load();
      assert.ok(initial.models.length >= 1);
      assert.ok(initial.activeModelId);

      // 1. 添加新模型（Claude 3.7 Sonnet）
      const added = await store.addModel(
        {
          name: 'Claude 3.7 (思考模式)',
          provider: 'openrouter',
          baseURL: 'https://openrouter.ai/api/v1',
          apiKey: 'sk-or-1234567890abcdef',
          model: 'anthropic/claude-3.7-sonnet:thinking',
          thinkingEnabled: true,
          thinkingLevel: 'high',
        },
        true, // 设为默认
      );

      assert.equal(added.models.length, 2);
      assert.equal(added.model, 'anthropic/claude-3.7-sonnet:thinking');
      assert.equal(added.thinkingLevel, 'high');
      assert.equal(added.activeModelId, added.models[1]!.id);

      // 2. 修改模型配置
      const updated = await store.updateModel(added.models[1]!.id, {
        name: 'Claude 3.7 (改名)',
        thinkingLevel: 'medium',
      });
      assert.equal(updated.models.find((m) => m.id === added.models[1]!.id)?.name, 'Claude 3.7 (改名)');
      assert.equal(updated.thinkingLevel, 'medium');

      // 3. 切换当前模型回第 1 个
      const switched = await store.setActiveModel(added.models[0]!.id);
      assert.equal(switched.activeModelId, added.models[0]!.id);
      assert.equal(switched.model, added.models[0]!.model);

      // 4. 删除第 2 个模型
      const deleted = await store.deleteModel(added.models[1]!.id);
      assert.equal(deleted.models.length, 1);
      assert.equal(deleted.activeModelId, added.models[0]!.id);

      // 5. 跨实例重新加载验证持久化
      const storeReloaded = new ModelConfigStore(env.dir);
      const loaded = await storeReloaded.load();
      assert.equal(loaded.models.length, 1);
      assert.equal(loaded.activeModelId, added.models[0]!.id);
    } finally {
      await env.cleanup();
    }
  });

  it('ModelConfigStore: 支持供应商与模型双层层级管理 (Provider -> Models)', async () => {
    const env = await tempDataDir('provider-hierarchy-test');
    try {
      const store = new ModelConfigStore(env.dir);
      const initial = await store.load();
      assert.ok(initial.providers.length >= 1);

      // 1. 添加新供应商「本地」
      const withLocal = await store.addProvider({
        id: 'provider-local-test',
        name: '本地',
        group: '自定义供应商',
        enabled: true,
        baseURL: 'http://192.168.0.102:8317/v1',
        apiFormat: 'responses',
        apiKey: '',
        models: [
          {
            id: 'model-glm-5-2',
            model: 'glm-5.2',
            name: 'glm-5.2',
            contextWindow: '200K',
            thinkingEnabled: true,
            thinkingLevel: 'medium',
          },
        ],
      });

      assert.ok(withLocal.providers.some((p) => p.id === 'provider-local-test'));
      const localProvider = withLocal.providers.find((p) => p.id === 'provider-local-test')!;
      assert.equal(localProvider.name, '本地');
      assert.equal(localProvider.apiFormat, 'responses');
      assert.equal(localProvider.models.length, 1);

      // 2. 为「本地」供应商添加第 2 个模型 deepseek-v4-flash
      const withSecondModel = await store.saveModelToProvider('provider-local-test', {
        id: 'model-deepseek-v4-flash',
        model: 'deepseek-v4-flash',
        name: 'deepseek-v4-flash',
        contextWindow: '400K',
        thinkingEnabled: true,
        thinkingLevel: 'high',
      });

      const updatedLocal = withSecondModel.providers.find((p) => p.id === 'provider-local-test')!;
      assert.equal(updatedLocal.models.length, 2);
      assert.equal(updatedLocal.models[1]!.contextWindow, '400K');

      // 3. 设为当前活跃供应商与模型
      const activated = await store.setActiveProviderAndModel('provider-local-test', 'model-glm-5-2');
      assert.equal(activated.activeProviderId, 'provider-local-test');
      assert.equal(activated.activeModelId, 'model-glm-5-2');
      assert.equal(activated.model, 'glm-5.2');
      assert.equal(activated.baseURL, 'http://192.168.0.102:8317/v1');

      // 4. 修改供应商信息（如重命名与禁用）
      const edited = await store.saveProvider({
        id: 'provider-local-test',
        name: '本地-改名',
        enabled: false,
      });
      const editedLocal = edited.providers.find((p) => p.id === 'provider-local-test')!;
      assert.equal(editedLocal.name, '本地-改名');
      assert.equal(editedLocal.enabled, false);

      // 5. 从供应商删除模型
      const deletedModel = await store.deleteModelFromProvider('provider-local-test', 'model-deepseek-v4-flash');
      const localAfterDel = deletedModel.providers.find((p) => p.id === 'provider-local-test')!;
      assert.equal(localAfterDel.models.length, 1);

      // 6. 持久化验证
      const storeReloaded = new ModelConfigStore(env.dir);
      const reloaded = await storeReloaded.load();
      assert.equal(reloaded.activeModelId, 'model-glm-5-2');
      assert.equal(reloaded.model, 'glm-5.2');
    } finally {
      await env.cleanup();
    }
  });
});

describe('供应商删除后的激活回退', () => {
  it('删除激活供应商后跳过禁用/无密钥的 providers[0]，落到可用的供应商', async () => {
    const env = await tempDataDir('provider-fallback-test');
    try {
      const store = new ModelConfigStore(env.dir);
      await store.load({ baseURL: 'https://api.stepfun.com/v1', apiKey: 'sk-seed-key-123', model: 'glm-5.2' });
      // 构造：providers[0] 被禁用，后面两个启用且带密钥
      await store.saveProvider({ id: 'provider-default', enabled: false });
      await store.saveProvider({
        id: 'provider-good',
        name: '可用供应商',
        baseURL: 'https://api.good.com/v1',
        apiKey: 'sk-good-key',
        enabled: true,
        models: [{ id: 'model-good-1', model: 'good-1', name: 'good-1', thinkingEnabled: false, thinkingLevel: 'medium' }],
      });
      await store.saveProvider({
        id: 'provider-active',
        name: '当前激活',
        baseURL: 'https://api.active.com/v1',
        apiKey: 'sk-active-key',
        enabled: true,
        models: [{ id: 'model-active-1', model: 'active-1', name: 'active-1', thinkingEnabled: false, thinkingLevel: 'medium' }],
      });
      const activated = await store.setActiveProviderAndModel('provider-active', 'model-active-1');
      assert.equal(activated.activeProviderId, 'provider-active');
      assert.equal(activated.model, 'active-1');

      // 删除当前激活的供应商： providers[0]（provider-default）已禁用，必须被跳过
      const afterDelete = await store.deleteProvider('provider-active');
      assert.equal(afterDelete.activeProviderId, 'provider-good');
      assert.equal(afterDelete.activeModelId, 'model-good-1');
      assert.equal(afterDelete.apiKey, 'sk-good-key');
      assert.notEqual(afterDelete.activeProviderId, 'provider-default');

      const reloaded = await new ModelConfigStore(env.dir).load();
      assert.equal(reloaded.activeProviderId, 'provider-good');
      assert.equal(reloaded.model, 'good-1');
    } finally {
      await env.cleanup();
    }
  });

  it('激活模型 id 失效时优先在当前激活供应商内按模型名找回', async () => {
    const env = await tempDataDir('active-model-recover-test');
    try {
      const store = new ModelConfigStore(env.dir);
      await store.load({ baseURL: 'https://api.a.com/v1', apiKey: 'sk-a', model: 'glm-5.2' });
      // 另一个供应商暴露同一个上游模型名，按名全局匹配会挑错人
      await store.saveProvider({
        id: 'provider-dup',
        name: '重名供应商',
        baseURL: 'https://api.b.com/v1',
        apiKey: 'sk-b',
        enabled: true,
        models: [{ id: 'model-dup-glm', model: 'glm-5.2', name: 'glm-5.2', thinkingEnabled: false, thinkingLevel: 'medium' }],
      });
      const activated = await store.setActiveProviderAndModel('provider-dup', 'model-dup-glm');
      assert.equal(activated.activeProviderId, 'provider-dup');
      assert.equal(activated.baseURL, 'https://api.b.com/v1');

      const broken = JSON.parse(JSON.stringify(activated));
      broken.activeModelId = 'model-does-not-exist';
      const recovered = (store as unknown as { normalizeLoaded: (input: typeof broken) => typeof broken }).normalizeLoaded(broken);
      assert.equal(recovered.activeProviderId, 'provider-dup');
      assert.equal(recovered.activeModelId, 'model-dup-glm');
      assert.equal(recovered.model, 'glm-5.2');
    } finally {
      await env.cleanup();
    }
  });
});
