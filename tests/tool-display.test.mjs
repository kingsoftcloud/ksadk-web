import test from 'node:test';
import assert from 'node:assert/strict';

async function loadToolDisplayUtils() {
  return import('../src/utils/tool-display.js').catch(() => null);
}

test('tool display formats nested JSON strings and decodes Chinese escapes', async () => {
  const toolDisplay = await loadToolDisplayUtils();

  assert.ok(toolDisplay, 'expected tool display helpers to exist');
  const formatted = toolDisplay.formatToolPayload(
    '[{"type":"input_text","text":"{\\"success\\":true,\\"analysis\\":\\"\\\\u6839\\\\u636e\\\\u622a\\\\u56fe\\\\u663e\\\\u793a\\"}"}]',
  );

  assert.equal(
    formatted,
    '[\n  {\n    "type": "input_text",\n    "text": {\n      "success": true,\n      "analysis": "根据截图显示"\n    }\n  }\n]',
  );
});

test('tool display marks explicit tool error payloads as failed', async () => {
  const toolDisplay = await loadToolDisplayUtils();

  assert.ok(toolDisplay, 'expected tool display helpers to exist');
  assert.equal(
    toolDisplay.isFailedToolOutput(
      '{"ok":false,"error_type":"SandboxException","error_message":"404: template not found"}',
    ),
    true,
  );
  assert.equal(toolDisplay.isFailedToolOutput('{"ok":true,"stdout":"42"}'), false);
});

test('tool display treats accepted memory extraction as non-failed', async () => {
  const toolDisplay = await loadToolDisplayUtils();

  assert.ok(toolDisplay, 'expected tool display helpers to exist');
  assert.equal(
    toolDisplay.isFailedToolOutput(
      '{"ok":false,"status":"accepted_not_extracted","message":"记忆保存请求已被后端受理，但尚未抽取成可检索记忆。","session_state":0,"session_id":"337abed10c4147ab"}',
    ),
    false,
  );
});
