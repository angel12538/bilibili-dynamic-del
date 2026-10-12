const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, '..', 'bili-dynamic-autodel.user.js'), 'utf8');
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

function element() {
    return {
        children: [], classList: { remove() {}, add() {} }, scrollHeight: 0, scrollTop: 0, clientHeight: 0,
        append(...items) { this.children.push(...items); items.forEach(item => item.parent = this); },
        appendChild(item) { this.append(item); },
        get firstElementChild() { return this.children[0]; },
        remove() { if (this.parent) this.parent.children.splice(this.parent.children.indexOf(this), 1); },
        set innerHTML(value) { if (value) throw new Error('日志不应解析HTML'); this.children = []; },
        addEventListener() {}, querySelector() { return null; }
    };
}

function harness(handler, values = {}) {
    const storage = new Map(Object.entries(values));
    const calls = [];
    const logs = element();
    const panel = { style: {}, classList: { remove() {} } };
    const context = {
        console: { log() {}, error() {}, warn() {} }, AbortController, URLSearchParams,
        setTimeout, clearTimeout, setInterval, clearInterval,
        document: {
            cookie: 'DedeUserID=123;bili_jct=test-token', readyState: 'loading',
            getElementById: id => id === 'bili-dynamic-progress-panel' ? panel : id === 'progress-logs' ? logs : null,
            querySelector: () => null, createElement: element, addEventListener() {}
        },
        localStorage: { getItem: () => null },
        GM_getValue: (key, fallback) => storage.has(key) ? storage.get(key) : fallback,
        GM_setValue: (key, value) => storage.set(key, structuredClone(value)),
        GM_info: { script: { name: 'test', version: 'test' } }, GM_notification() {},
        prompt: () => null, confirm: () => true,
        axios: async config => {
            calls.push(config);
            return { data: await handler(config, calls.length) };
        }
    };
    context.window = context;
    context.self = context.top = context;
    context.addEventListener = () => {};
    const exports = `globalThis.api = {
        CONFIG, getDynamics, start, stopProcessing, togglePause, checkLotteryStatus,
        getForwardDynamicDate, getBeforeDate, generateReport, getUnfollowList, getLotteryApiRetries,
        addProgressLog, requestWithRetry, unfollowUser,
        get progress() { return progressData; }, get running() { return isRunning; },
        begin() { isRunning = true; runController = new AbortController(); initProgressData('test'); },
        async finish() { runController.abort(); await mutationQueue; isRunning = false; }
    };`;
    vm.runInNewContext(source.replace(/\}\)\(\);\s*$/, `${exports}\n})();`), context);
    Object.assign(context.api.CONFIG, { REQUEST_DELAY: 0, RETRY_DELAY: 1, PAUSE_CHECK_INTERVAL: 2 });
    return { api: context.api, storage, calls, logs, context };
}

function forward(id, orig = null, timestamp = 1600000000) {
    return { id_str: id, type: 'DYNAMIC_TYPE_FORWARD', orig, modules: { module_author: { pub_ts: timestamp } } };
}
function original(id, uid = '456') {
    return { id_str: id, modules: { module_author: { name: '用户', mid: uid, following: true } } };
}
function feed(items, offset = '', has_more = false) { return { code: 0, data: { items, offset, has_more } }; }

test('缺失源动态可删除，自发动态即使带orig也不删除，重复ID只处理一次', async () => {
    const h = harness(config => config.method === 'post' ? { code: '0' } : feed([
        forward('1'), forward('1'), { ...forward('2', original('8')), type: 'DYNAMIC_TYPE_WORD' }
    ]));
    await h.api.getDynamics('123', '', 'auto', '30');
    assert.equal(h.calls.filter(call => call.method === 'post').length, 1);
    assert.equal(h.calls[1].data.dyn_id_str, '1');
    assert.equal(h.api.progress.deletedItems, 1);
    assert.equal(h.api.progress.processedItems, 2);
    assert.equal(h.api.progress.currentStatus, '处理完成');
    assert.ok(h.api.progress.endTime);
});

test('相同源动态并发查询复用一次请求，字符串开奖状态可识别', async () => {
    const h = harness(async config => {
        if (config.method === 'post') return { code: 0 };
        if (config.url.includes('lottery_notice')) { await delay(5); return { code: 0, data: { status: '2' } }; }
        return feed([forward('1', original('9')), forward('2', original('9'))]);
    });
    await h.api.getDynamics('123', '', 'auto', '30');
    assert.equal(h.calls.filter(call => call.url.includes('lottery_notice')).length, 1);
    assert.equal(h.api.progress.deletedItems, 2);
});

test('日期模式保留未开奖、日期无效及日期过新的转发', async () => {
    const h = harness(config => {
        if (config.method === 'post') return { code: 0 };
        if (config.url.includes('lottery_notice')) return { code: 0, data: { status: 0 } };
        return feed([forward('1', original('9')), forward('2', null, '昨天'), forward('3', null, Date.now() / 1000), forward('4')]);
    });
    await h.api.getDynamics('123', '', 'days_ago', '30');
    assert.deepEqual(h.calls.filter(call => call.method === 'post').map(call => call.data.dyn_id_str), ['4']);
});

test('日期模式删除非抽奖；抽奖查询失败时跳过', async () => {
    const h = harness(config => {
        if (config.method === 'post') return { code: 0 };
        if (config.url.includes('lottery_notice')) return { code: config.params.business_id === '9' ? -400 : -123 };
        return feed([forward('1', original('9')), forward('2', original('10'))]);
    });
    await h.api.getDynamics('123', '', 'days_ago', '30');
    assert.deepEqual(h.calls.filter(call => call.method === 'post').map(call => call.data.dyn_id_str), ['1']);
});

test('指定用户支持UID及姓名，源动态缺失不会崩溃', async () => {
    const h = harness(config => config.method === 'post' ? { code: 0 } : feed([
        forward('1', original('9', '456')), forward('2', original('10', '789')), forward('3')
    ]));
    await h.api.getDynamics('123', '', 'user', '456');
    assert.deepEqual(h.calls.filter(call => call.method === 'post').map(call => call.data.dyn_id_str), ['1']);
});

test('has_more为0时忽略残留offset并完成空页', async () => {
    const h = harness(() => feed([], 'still-present', 0));
    await h.api.getDynamics('123', '', 'auto', '30');
    assert.equal(h.calls.length, 1);
    assert.equal(h.api.progress.currentStatus, '处理完成');
});

test('重复分页游标终止任务，不重复请求', async () => {
    const h = harness(() => feed([], 'same', true));
    await h.api.getDynamics('123', '', 'auto', '30');
    assert.equal(h.calls.length, 2);
    assert.equal(h.api.progress.currentStatus, '处理出错');
});

test('末页缺失items可完成，非末页缺失items或未知分页标记报错', async () => {
    const empty = harness(() => ({ code: 0, data: { has_more: 0 } }));
    await empty.api.getDynamics('123', '', 'auto', '30');
    assert.equal(empty.api.progress.currentStatus, '处理完成');
    for (const body of [{ has_more: 1 }, { items: [], has_more: 'unknown' }]) {
        const h = harness(() => ({ code: 0, data: body }));
        await h.api.getDynamics('123', '', 'auto', '30');
        assert.equal(h.api.progress.currentStatus, '处理出错');
        assert.equal(h.calls.length, 1);
    }
});

test('连续10页开启自动暂停时，末页直接完成', async () => {
    const h = harness((config, count) => feed([], String(count), count < 10), { 'auto-pause': true });
    await h.api.getDynamics('123', '', 'auto', '30');
    assert.equal(h.calls.length, 10);
    assert.equal(h.api.progress.currentStatus, '处理完成');
});

test('风控只有限重试，耗尽后终止而不是无限翻页', async () => {
    const h = harness(() => ({ code: -352 }));
    await h.api.getDynamics('123', '', 'auto', '30');
    assert.equal(h.calls.length, 3);
    assert.equal(h.api.progress.currentStatus, '处理出错');
});

test('停止会取消在途请求、禁止队列删除及阻止旧任务未结束时重启', async () => {
    let cancel;
    const h = harness(config => {
        if (!config.method) return feed([forward('1'), forward('2'), forward('3')]);
        return new Promise((resolve, reject) => {
            cancel = () => { const error = new Error('canceled'); error.code = 'ERR_CANCELED'; reject(error); };
            config.signal.addEventListener('abort', cancel, { once: true });
        });
    });
    const run = h.api.getDynamics('123', '', 'auto', '30');
    while (!cancel) await delay(1);
    h.api.stopProcessing();
    assert.equal(await h.api.start('auto'), false);
    await run;
    assert.equal(h.calls.filter(call => call.method === 'post').length, 1);
    assert.equal(h.api.running, false);
    assert.equal(h.api.progress.currentStatus, '已停止');
    assert.ok(h.api.progress.endTime);
});

test('重试等待中停止，不再发送后续请求', async () => {
    const h = harness(() => { const error = new Error('Network Error'); error.code = 'ERR_NETWORK'; throw error; });
    h.api.CONFIG.RETRY_DELAY = 500;
    const run = h.api.getDynamics('123', '', 'auto', '30');
    while (!h.calls.length) await delay(1);
    h.api.stopProcessing();
    await run;
    assert.equal(h.calls.length, 1);
    assert.equal(h.api.progress.currentStatus, '已停止');
});

test('暂停后排队删除等待继续，写请求串行且有间隔', async () => {
    let active = 0, maxActive = 0;
    const times = [];
    let paused;
    const pauseReached = new Promise(resolve => paused = resolve);
    const h = harness(async config => {
        if (!config.method) return feed([forward('1'), forward('2'), forward('3')]);
        times.push(Date.now()); maxActive = Math.max(maxActive, ++active);
        if (times.length === 1) { h.api.togglePause(); paused(); }
        await delay(4); active--;
        return { code: 0 };
    });
    h.api.CONFIG.REQUEST_DELAY = 15;
    const run = h.api.getDynamics('123', '', 'auto', '30');
    await pauseReached;
    await delay(25);
    assert.equal(times.length, 1);
    h.api.togglePause();
    await run;
    assert.equal(maxActive, 1);
    assert.equal(times.length, 3);
    assert.ok(times[2] - times[1] >= 14);
});

test('删除返回404不虚增删除统计，也不添加取关', async () => {
    const h = harness(config => {
        if (config.method === 'post') return { code: -404 };
        if (config.url.includes('lottery_notice')) return { code: 0, data: { status: 2 } };
        return feed([forward('1', original('9'))]);
    }, { 'set-unfollow': true });
    await h.api.getDynamics('123', '', 'auto', '30');
    assert.equal(h.api.progress.deletedItems, 0);
    assert.equal(h.api.progress.deletedDetails.length, 0);
    assert.equal(h.api.getUnfollowList().length, 0);
});

test('取关兼容旧UID字符串，失败保留，成功移除并包含在报告中', async () => {
    const h = harness(config => {
        if (!config.method) return feed([]);
        return { code: config.data.get('fid') === '1' ? -123 : 0 };
    }, { 'set-unfollow': true, 'unfollow-list': ['1', { uid: 2, name: '成功用户' }, '2', null] });
    await h.api.getDynamics('123', '', 'auto', '30');
    assert.deepEqual(JSON.parse(JSON.stringify(h.api.getUnfollowList())), [{ uid: '1', name: '1' }]);
    assert.equal(h.api.progress.unfollowedUsers, 1);
    assert.match(h.api.generateReport(), /成功用户/);
    assert.match(h.api.generateReport(), /失败原因/);
});

test('取关中停止保留当前和未处理用户', async () => {
    let started;
    const reached = new Promise(resolve => started = resolve);
    const h = harness(config => {
        if (!config.method) return feed([]);
        started();
        return new Promise((resolve, reject) => config.signal.addEventListener('abort', () => {
            const error = new Error('canceled'); error.code = 'ERR_CANCELED'; reject(error);
        }, { once: true }));
    }, { 'set-unfollow': true, 'unfollow-list': ['1', '2'] });
    const run = h.api.getDynamics('123', '', 'auto', '30');
    await reached; h.api.stopProcessing(); await run;
    assert.equal(h.api.getUnfollowList().length, 2);
});

test('CSRF失效立即终止，不继续删除或取关', async () => {
    const h = harness(config => config.method === 'post' ? { code: -403 } : feed([forward('1'), forward('2')]));
    await h.api.getDynamics('123', '', 'auto', '30');
    assert.equal(h.calls.filter(call => call.method === 'post').length, 1);
    assert.equal(h.api.progress.currentStatus, '处理出错');
});

test('日志按纯文本插入，DOM与内存均限制长度', () => {
    const h = harness(() => ({ code: 0 }));
    h.api.CONFIG.MAX_VISIBLE_LOGS = 2; h.api.CONFIG.MAX_STORED_LOGS = 3;
    for (let i = 0; i < 5; i++) h.api.addProgressLog('<img src=x onerror=alert(1)>');
    assert.equal(h.logs.children.length, 2);
    assert.equal(h.logs.children[0].children[1].textContent, '<img src=x onerror=alert(1)>');
    assert.equal(h.api.progress.logs.length, 3);
});

test('运行中导出报告不会冻结endTime，报告保留当前状态', async () => {
    const h = harness(() => ({ code: 0 }));
    h.api.begin();
    const report = h.api.generateReport();
    assert.equal(h.api.progress.endTime, null);
    assert.match(report, /执行状态：初始化/);
    await h.api.finish();
});

test('日期读取支持毫秒且回退到有效字段，损坏的重试设置使用默认值', () => {
    const h = harness(() => ({ code: 0 }), { 'lottery-api-retries': 'bad' });
    assert.equal(h.api.getLotteryApiRetries(), 2);
    const data = forward('1', null, '昨天'); data.timestamp = 1600000000000;
    assert.equal(h.api.getForwardDynamicDate(data).timestamp, 1600000000);
    assert.equal(h.api.getForwardDynamicDate(forward('2', null, 'Invalid')).success, false);
});

test('日期输入必须是完整正整数，不接受小数或带后缀', async () => {
    const h = harness(() => { throw new Error('无效输入不应发请求'); });
    for (const value of ['3abc', '1.5', '0', '-1', '', '999999999999999999']) {
        h.context.prompt = () => value;
        assert.equal(await h.api.start('days_ago'), false);
        assert.equal(await h.api.start('auto'), false);
    }
    h.context.prompt = () => ', ,';
    assert.equal(await h.api.start('user'), false);
    assert.equal(h.calls.length, 0);
});

test('自动判断先输入天数并确认截止日期，仅删除范围内已开奖或源已删除的转发', async () => {
    let prompts = 0, confirmations = 0;
    const h = harness(config => {
        if (config.method === 'post') return { code: 0 };
        if (config.url.includes('lottery_notice')) {
            const id = config.params.business_id;
            return id === '10' ? { code: -400 } : { code: 0, data: { status: id === '9' ? 2 : 1 } };
        }
        const cutoff = new Date(`${h.api.getBeforeDate(30)}T23:59:59`);
        const recent = new Date(cutoff); recent.setDate(recent.getDate() + 1);
        return feed([
            forward('1', null, cutoff.getTime() / 1000),
            forward('2', original('9')),
            forward('3', null, recent.getTime() / 1000),
            forward('4', original('10')),
            forward('5', original('11')),
            forward('6', null, '昨天')
        ]);
    });
    h.context.prompt = message => {
        prompts++;
        assert.match(message, /清理多少天前/);
        assert.equal(h.calls.length, 0);
        return ' 30 ';
    };
    h.context.confirm = message => {
        confirmations++;
        assert.ok(message.includes(h.api.getBeforeDate(30)));
        assert.match(message, /含当天/);
        assert.match(message, /自动判断仅删除已开奖抽奖/);
        assert.equal(h.calls.length, 0);
        return true;
    };
    assert.equal(await h.api.start('auto'), true);
    assert.equal(prompts, 1);
    assert.equal(confirmations, 1);
    assert.deepEqual(h.calls.filter(call => call.method === 'post').map(call => call.data.dyn_id_str), ['1', '2']);
    assert.equal(h.api.progress.deletedItems, 2);
});

test('自动判断取消天数输入或最终确认时不发请求', async () => {
    for (const cancelInput of [true, false]) {
        let confirmations = 0;
        const h = harness(() => { throw new Error('取消后不应发请求'); });
        h.context.prompt = () => cancelInput ? null : '30';
        h.context.confirm = () => { confirmations++; return false; };
        assert.equal(await h.api.start('auto'), false);
        assert.equal(h.calls.length, 0);
        assert.equal(confirmations, cancelInput ? 0 : 1);
        assert.equal(h.api.running, false);
    }
});

test('缺少有效天数时自动判断不能绕过弹窗直接清理全部日期', async () => {
    const h = harness(() => { throw new Error('无有效日期范围不应发请求'); });
    for (const value of ['', null, 'invalid', '0']) {
        assert.equal(await h.api.getDynamics('123', '', 'auto', value), false);
    }
    assert.equal(h.calls.length, 0);
    assert.equal(h.api.running, false);
});
