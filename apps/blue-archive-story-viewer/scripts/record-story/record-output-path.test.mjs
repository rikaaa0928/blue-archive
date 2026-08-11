import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { resolveRecordOutputPath } from './record-output-path.mjs';

function writeStory(root, id, content) {
  const directory = path.join(root, 'public', 'story', 'event', '12345');
  fs.mkdirSync(directory, { recursive: true });
  fs.writeFileSync(
    path.join(directory, `${id}.json`),
    `${JSON.stringify({ content }, null, 2)}\n`,
  );
}

test('uses the current story title from the Chinese title row', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'record-output-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  writeStory(root, '12345010', [{
    ScriptKr: '#title;제1화;덤벼드는 녀석',
    TextCn: '第1话;向我冲过来的家伙',
  }]);

  const output = resolveRecordOutputPath('eventStory/12345010', {
    appRoot: root,
  });
  assert.equal(
    output.relativeBasePath,
    path.join('event', '12345', '12345010-向我冲过来的家伙'),
  );
});

test('inherits the nearest earlier title by sorted id and numbers each part', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'record-output-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  writeStory(root, '12345010', [{
    ScriptKr: '#title;제1화;덤벼드는 녀석',
    TextCn: '第1话;向我冲过来的家伙',
  }]);
  writeStory(root, '12345011', []);
  writeStory(root, '12345019', []);

  assert.equal(
    resolveRecordOutputPath('eventStory/12345011', { appRoot: root })
      .relativeBasePath,
    path.join('event', '12345', '12345011-向我冲过来的家伙(2)'),
  );
  assert.equal(
    resolveRecordOutputPath('eventStory/12345019', { appRoot: root })
      .relativeBasePath,
    path.join('event', '12345', '12345019-向我冲过来的家伙(3)'),
  );
});

test('starts numbering again after a later story defines its own title', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'record-output-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  writeStory(root, '12345010', [{
    ScriptKr: '#title;제1화;첫 제목',
    TextCn: '第1话;第一个标题',
  }]);
  writeStory(root, '12345011', []);
  writeStory(root, '12345020', [{
    ScriptKr: '#title;제2화;두 번째 제목',
    TextCn: '第2话;第二个标题',
  }]);
  writeStory(root, '12345023', []);

  assert.equal(
    resolveRecordOutputPath('eventStory/12345020', { appRoot: root }).fileStem,
    '12345020-第二个标题',
  );
  assert.equal(
    resolveRecordOutputPath('eventStory/12345023', { appRoot: root }).fileStem,
    '12345023-第二个标题(2)',
  );
});

test('falls back to the id and keeps language variants separate', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'record-output-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  writeStory(root, '12345007', []);

  assert.equal(
    resolveRecordOutputPath('eventStory/12345007', { appRoot: root }).fileStem,
    '12345007',
  );
  assert.equal(
    resolveRecordOutputPath('eventStory/12345007', {
      appRoot: root,
      subtitleLanguage: 'en',
    }).fileStem,
    '12345007_en',
  );
});
