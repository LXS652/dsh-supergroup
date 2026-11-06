import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { test } from 'node:test';

const read = (rel) => readFileSync(new URL(`../${rel}`, import.meta.url), 'utf8');
const pkg = JSON.parse(read('package.json'));
const require = createRequire(import.meta.url);

test('元数据一致性：包名、客户端模块 id、patch insert 五方对齐', () => {
    assert.equal(pkg.name, 'dsh-supergroup');
    assert.match(pkg.version, /^\d+\.\d+\.\d+$/);

    const client = read('client/client.js');
    assert.match(client, /__ModuleLoader__\.load\(\{\s*id:\s*'dsh-supergroup'/);

    const patch = read('cordis.patch.yml');
    assert.match(patch, /^\s*-\s*id:\s*dsh-supergroup\s*$/m);
    assert.match(patch, /^\s*name:\s*dsh-supergroup\s*$/m);
    assert.doesNotMatch(patch, /<你的/);
    assert.doesNotMatch(patch, /file:/);
});

test('locale 元数据：中英文标题都存在，英文入口不能缺', () => {
    const en = JSON.parse(read('locale/en.json'));
    const zh = JSON.parse(read('locale/zh.json'));
    assert.equal(typeof en.meta?.title, 'string');
    assert.notEqual(en.meta.title.trim(), '');
    assert.equal(zh.meta?.title, '超级代理部署');
    assert.notEqual(zh.meta.description.trim(), '');
});

test('发布面：exports 与 files 覆盖 manifest、locale 与图标', () => {
    const exportKeys = Object.keys(pkg.exports);
    assert.ok(exportKeys.includes('./package.json'));
    assert.ok(exportKeys.includes('./locale/*.json'));
    assert.ok(pkg.files.includes('locale'));
    assert.ok(pkg.files.includes('icon.svg'));
    assert.equal(pkg.icon, './icon.svg');

    const icon = read('icon.svg');
    assert.match(icon, /viewBox="0 0 24 24"/);
    assert.match(icon, /stroke="currentColor"/);
    assert.ok(Buffer.byteLength(icon, 'utf8') <= 256 * 1024);
});

test('自引用解析：包名、package.json 与中英文 locale 都能被 Node 解析', () => {
    const resolved = require('dsh-supergroup/package.json');
    assert.equal(resolved.name, 'dsh-supergroup');
    assert.equal(require('dsh-supergroup/locale/zh.json').meta.title, '超级代理部署');
    assert.equal(require('dsh-supergroup/locale/en.json').meta.title, 'Supergroup');
});

test('patch 只有单个 insert，且没有覆盖 config', () => {
    const patch = read('cordis.patch.yml');
    assert.equal((patch.match(/^\s*-\s*insert:\s*$/gm) ?? []).length, 1);
    assert.doesNotMatch(patch, /^\s*config:\s*$/m);
    assert.match(patch, /^\s*-\s*id:\s*dsh-supergroup\s*$/m);
    assert.match(patch, /^\s*name:\s*dsh-supergroup\s*$/m);
});

test('bundle 字段与发布清单包含 patch 文件', () => {
    assert.equal(pkg.dsh.bundle.patch, './cordis.patch.yml');
    assert.ok(existsSync(new URL('../cordis.patch.yml', import.meta.url)));
    assert.ok(pkg.files.includes('cordis.patch.yml'));
});

test('客户端身份对齐：loader id、PANEL_ID 与两个槽位成对', () => {
    const client = read('client/client.js');
    assert.match(client, /__ModuleLoader__\.load\(\{\s*id:\s*'dsh-supergroup'/);
    assert.match(client, /const PANEL_ID = 'dsh-supergroup'/);
    assert.match(client, /name: 'sidebar\.panellist'/);
    assert.match(client, /name: 'main'/);
});

test('exports 精确集合：入口、客户端、manifest 与 locale 通配', () => {
    assert.deepEqual(Object.keys(pkg.exports), ['.', './client', './package.json', './locale/*.json']);
});
