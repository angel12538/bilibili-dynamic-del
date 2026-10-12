// ==UserScript==
// @name         B站动态自动清理
// @namespace    https://github.com/
// @version      2026.10.12
// @description  删除B站转发的已开奖动态和源动态已被删除的动态
// @author       monSteRhhe
// @match        http*://*.bilibili.com/*
// @icon         https://www.bilibili.com/favicon.ico
// @grant        GM_info
// @grant        GM_addStyle
// @grant        GM_setValue
// @grant        GM_getValue
// @grant        GM_notification
// @grant        GM_registerMenuCommand
// @grant        GM_download
// @run-at       document-end
// @noframes
// @require      https://unpkg.com/axios/dist/axios.min.js
// ==/UserScript==
/* globals axios */

(function() {
    'use strict';

    // ========== 防重复执行检查 ==========
    if (window.biliDynamicAutoDelLoaded) {
        console.log('Bili.Dynamic.AutoDel Pro 已加载，跳过重复执行');
        return;
    }
    window.biliDynamicAutoDelLoaded = true;

    if (window.self !== window.top) {
        console.log('Bili.Dynamic.AutoDel Pro 在iframe中，跳过执行');
        return;
    }

    // ========== 配置常量 ==========
    const CONFIG = {
        REQUEST_DELAY: 3000,
        RETRY_DELAY: 5000,
        MAX_RETRIES: 2,
        BATCH_SIZE: 5,
        PAUSE_CHECK_INTERVAL: 1000,
        LOTTERY_API_TIMEOUT: 8000,
        MAX_VISIBLE_LOGS: 200,
        MAX_STORED_LOGS: 1000,
        MAX_LOTTERY_CACHE: 500
    };

    // ========== 执行状态管理 ==========
    let isRunning = false;
    let isPaused = false;
    let runController = null;
    let mutationQueue = Promise.resolve();
    let lastMutationTime = 0;
    let progressTimer = null;
    let runFailure = null;
    const lotteryCache = new Map();
    const seenDynamics = new Set();
    let menuCommandsRegistered = false;
    let progressData = {
        currentPage: 0,
        processedItems: 0,
        deletedItems: 0,
        unfollowedUsers: 0,
        currentStatus: '等待中',
        mode: '',
        startTime: null,
        endTime: null,
        deletedDetails: [],
        unfollowedDetails: [],
        unfollowFailedDetails: [],
        logs: []
    };

    // ========== 工具函数 ==========

    // 获取抽奖API重试次数
    function getLotteryApiRetries() {
        const retries = Number(GM_getValue('lottery-api-retries', 2));
        return Number.isInteger(retries) && retries >= 0 && retries <= 5 ? retries : 2;
    }

    function initSettings() {
        if (GM_getValue('set-unfollow') === undefined) {
            GM_setValue('set-unfollow', false);
        }
        if (GM_getValue('unfollow-list') === undefined) {
            GM_setValue('unfollow-list', []);
        }
        if (GM_getValue('auto-pause') === undefined) {
            GM_setValue('auto-pause', false);
        }
        if (GM_getValue('export-path') === undefined) {
            GM_setValue('export-path', 'BiliDynamicCleaner');
        }
        if (GM_getValue('lottery-api-retries') === undefined) {
            GM_setValue('lottery-api-retries', 2);
        }
    }

    function getCSRFToken() {
        const cookies = document.cookie;
        const match = cookies.match(/(^|;\s*)bili_jct=([^;]*)/);
        if (match) return match[2];

        try {
            const localData = JSON.parse(localStorage.getItem('bp_t_offset') || '{}');
            if (localData.csrf) return localData.csrf;
        } catch (e) {
            console.log('从localStorage获取CSRF失败:', e);
        }

        return null;
    }

    function getUserID() {
        const cookies = document.cookie;
        const match = cookies.match(/(^|;\s*)DedeUserID=([^;]*)/);
        return match ? match[2] : null;
    }

    function getBeforeDate(num) {
        let d = new Date();
        d.setDate(d.getDate() - num);
        let year = d.getFullYear(),
            month = d.getMonth() + 1,
            day = d.getDate(),
            before_date = year + '-' +
                        (month < 10 ? ('0' + month) : month) + '-' +
                        (day < 10 ? ('0' + day) : day);
        return before_date;
    }

    function timestampToDate(ts) {
        if (!ts) return '';
        let date = new Date(ts * 1000),
            year = date.getFullYear(),
            month = date.getMonth() + 1,
            day = date.getDate(),
            dyn_date = year + '-' +
                      (month < 10 ? ('0' + month) : month) + '-' +
                      (day < 10 ? ('0' + day) : day);
        return dyn_date;
    }

    function sleep(ms) {
        const signal = runController?.signal;
        return new Promise(resolve => {
            if (signal?.aborted) return resolve();
            const finish = () => {
                clearTimeout(timer);
                signal?.removeEventListener('abort', finish);
                resolve();
            };
            const timer = setTimeout(finish, ms);
            signal?.addEventListener('abort', finish, { once: true });
        });
    }

    function isTaskActive() {
        return isRunning && !runController?.signal.aborted;
    }

    async function waitUntilReady() {
        while (isPaused && isTaskActive()) await sleep(CONFIG.PAUSE_CHECK_INTERVAL);
        return isTaskActive();
    }

    function cancellationError() {
        const error = new Error('任务已停止');
        error.code = 'ERR_CANCELED';
        return error;
    }

    function isCancellation(error) {
        return error?.code === 'ERR_CANCELED' || error?.name === 'AbortError';
    }

    // 查询可并发；删除和取关共用队列，限制实际写请求之间的间隔。
    async function apiRequest(config, mutation = false) {
        const execute = async () => {
            if (mutation) await sleep(Math.max(0, CONFIG.REQUEST_DELAY - (Date.now() - lastMutationTime)));
            if (!await waitUntilReady()) throw cancellationError();
            if (mutation) lastMutationTime = Date.now();
            const response = await axios({
                timeout: 10000,
                withCredentials: true,
                ...config,
                signal: runController.signal
            });
            const body = response.data;
            if (!body || !['number', 'string'].includes(typeof body.code) || String(body.code).trim() === '') {
                throw new Error('API响应格式无效');
            }
            const code = Number(body.code);
            if ([-101, -111, -403].includes(code)) {
                const error = new Error(`登录或CSRF校验失败: ${body.message || code}`);
                error.fatal = true;
                runFailure = error;
                runController.abort();
                throw error;
            }
            return body;
        };
        if (!mutation) return execute();
        const pending = mutationQueue.then(execute);
        mutationQueue = pending.catch(() => {});
        return pending;
    }

    function apiError(body) {
        const error = new Error(`API返回错误: ${body.message || '未知错误'} (code: ${body.code})`);
        error.apiCode = Number(body.code);
        return error;
    }

    function canRetry(error) {
        if (isCancellation(error) || error.fatal) return false;
        if (error.apiCode !== undefined) return [-352, -500, 4128002].includes(error.apiCode);
        const status = error.response?.status;
        return status ? status === 408 || status === 429 || status >= 500 :
            ['ECONNABORTED', 'ETIMEDOUT', 'ERR_NETWORK'].includes(error.code) || /Network Error|timeout/i.test(error.message);
    }

    async function requestWithRetry(config, retries = CONFIG.MAX_RETRIES, mutation = false, allowedCodes = [0]) {
        for (let attempt = 0; ; attempt++) {
            try {
                const body = await apiRequest(config, mutation);
                if (!allowedCodes.includes(Number(body.code))) throw apiError(body);
                return body;
            } catch (error) {
                if (attempt >= retries || !canRetry(error)) {
                    if ([-352, 4128002].includes(error.apiCode) || [412, 429].includes(error.response?.status)) {
                        error.fatal = true;
                        runFailure = error;
                        runController.abort();
                    }
                    throw error;
                }
                addProgressLog(`请求失败，${CONFIG.RETRY_DELAY * (attempt + 1) / 1000}秒后重试 (${attempt + 1}/${retries}): ${error.message}`, 'warning');
                await sleep(CONFIG.RETRY_DELAY * (attempt + 1));
            }
        }
    }

    function getUnfollowList() {
        const stored = GM_getValue('unfollow-list', []);
        const users = new Map();
        if (!Array.isArray(stored)) return [];
        for (const item of stored) {
            const uid = String(item && typeof item === 'object' ? item.uid ?? '' : item ?? '');
            if (/^[1-9]\d*$/.test(uid) && !users.has(uid)) {
                users.set(uid, { uid, name: String(item?.name || uid) });
            }
        }
        return [...users.values()];
    }

    function formatTime(ms) {
        const totalSeconds = Math.floor(ms / 1000);
        const minutes = Math.floor(totalSeconds / 60);
        const seconds = totalSeconds % 60;
        return `${minutes.toString().padStart(2, '0')}:${seconds.toString().padStart(2, '0')}`;
    }

    function getDynamicContent(data) {
        try {
            if (!data.orig) return '[无源动态]';

            const modules = data.orig.modules;
            if (!modules) return '[无法获取内容]';

            let content = '';

            if (modules.module_dynamic && modules.module_dynamic.desc) {
                content = modules.module_dynamic.desc.text || '';
            } else if (modules.module_content && modules.module_content.desc) {
                content = modules.module_content.desc.text || '';
            }

            if (content.length > 100) {
                content = content.substring(0, 100) + '...';
            }

            return content || '[无文本内容]';
        } catch (e) {
            return '[内容解析错误]';
        }
    }

    // 获取转发动态日期的函数（带重试机制）

    // 同一条响应里的字段不会因等待而变化，直接检查所有候选时间戳。
    function getForwardDynamicDate(data) {
        const author = data.modules?.module_author;
        const candidates = [author?.pub_ts, author?.pubtime, data.pub_ts, data.pubtime, data.ctime, data.timestamp];
        for (const value of candidates) {
            if (typeof value !== 'number' && !(typeof value === 'string' && /^\d+$/.test(value))) continue;
            let timestamp = Number(value);
            if (timestamp > 1e12) timestamp /= 1000;
            if (!Number.isFinite(timestamp) || timestamp <= 0 || !Number.isFinite(new Date(timestamp * 1000).getTime())) continue;
            return { success: true, timestamp, date: timestampToDate(timestamp) };
        }
        return { success: false, timestamp: null, date: null };
    }


    async function checkLotteryStatus(dynamicId) {
        const key = String(dynamicId);
        if (lotteryCache.has(key)) return lotteryCache.get(key);
        const pending = (async () => {
            try {
                const body = await requestWithRetry({
                    url: 'https://api.vc.bilibili.com/lottery_svr/v1/lottery_svr/lottery_notice',
                    params: { business_type: 4, business_id: key },
                    timeout: CONFIG.LOTTERY_API_TIMEOUT
                }, getLotteryApiRetries(), false, [0, -400, -9999]);
                const value = body.data?.status;
                const isLottery = Number(body.code) === 0 && value !== null && value !== undefined;
                const status = isLottery ? Number(value) : null;
                if (isLottery && (String(value).trim() === '' || !Number.isFinite(status))) throw new Error('抽奖状态格式无效');
                return { success: true, isLottery, status };
            } catch (error) {
                if (isCancellation(error) || error.fatal) throw error;
                return { success: false, error: { code: error.apiCode ?? error.code ?? 'UNKNOWN', message: error.message } };
            }
        })();
        lotteryCache.set(key, pending);
        if (lotteryCache.size > CONFIG.MAX_LOTTERY_CACHE) lotteryCache.delete(lotteryCache.keys().next().value);
        try {
            const result = await pending;
            if (!result.success) lotteryCache.delete(key);
            return result;
        } catch (error) {
            lotteryCache.delete(key);
            throw error;
        }
    }

    // ========== 样式管理 ==========

    function addStylesOnce() {
        if (document.getElementById('bili-dynamic-autodel-styles')) {
            return;
        }

        let style = document.createElement('style');
        style.id = 'bili-dynamic-autodel-styles';
        style.textContent = `
            .setting-popup {
                position: fixed;
                top: 0;
                left: 0;
                width: 100%;
                height: 100%;
                background-color: rgba(0, 0, 0, 0.5);
                z-index: 10000;
                display: flex;
                justify-content: center;
                align-items: center;
            }
            .setting-content {
                color: #000;
                position: relative;
                width: 450px;
                max-width: 90%;
                background-color: #efecfa;
                border-radius: 12px;
                padding: 25px;
                box-shadow: 0 8px 32px rgba(0, 0, 0, 0.25);
            }
            .setting-content .setting-header {
                font-size: 24px;
                font-weight: bold;
                line-height: 28px;
                padding: 10px 0 15px 0;
                margin-bottom: 15px;
                border-bottom: 2px solid #ddd;
                text-align: center;
                color: #00a1d6;
            }
            .setting-content .setting-body {
                width: 100%;
                margin: 0 auto;
                padding: 15px;
                background-color: #fff;
                border-radius: 10px;
                font-size: 14px;
                overflow-y: auto;
                max-height: 60vh;
            }
            .setting-item {
                padding: 15px 20px;
                display: flex;
                justify-content: space-between;
                align-items: center;
                border-bottom: 1px solid #f0f0f0;
            }
            .setting-item:last-child {
                border-bottom: none;
            }
            .setting-item label {
                font-weight: bold;
                color: #333;
                flex: 1;
            }
            .setting-item .checkbox-container {
                display: flex;
                align-items: center;
                gap: 10px;
            }
            .setting-item input[type="checkbox"] {
                width: 20px;
                height: 20px;
                cursor: pointer;
                accent-color: #00a1d6;
            }
            .setting-item .help-text {
                font-size: 12px;
                color: #666;
                margin-top: 5px;
                font-weight: normal;
            }
            .setting-content .setting-footer {
                display: flex;
                justify-content: flex-end;
                gap: 12px;
                padding: 20px 0 0 0;
                margin-top: 15px;
                border-top: 1px solid #ddd;
            }
            .setting-content .setting-footer button {
                cursor: pointer;
                border-radius: 6px;
                border: none;
                height: 38px;
                min-width: 90px;
                padding: 0 24px;
                font-size: 15px;
                font-weight: 500;
                transition: all 0.2s ease;
            }
            .setting-content .setting-footer .primary-btn {
                background-color: #00a1d6;
                color: white;
            }
            .setting-content .setting-footer .primary-btn:hover {
                background-color: #008cba;
                transform: translateY(-2px);
                box-shadow: 0 4px 12px rgba(0, 161, 214, 0.3);
            }
            .setting-content .setting-footer .secondary-btn {
                background-color: #f0f0f0;
                color: #666;
            }
            .setting-content .setting-footer .secondary-btn:hover {
                background-color: #e0e0e0;
            }

            /* 进度面板样式 */
            #bili-dynamic-progress-panel {
                position: fixed;
                top: 20px;
                right: 20px;
                width: 380px;
                background: white;
                border-radius: 12px;
                box-shadow: 0 8px 32px rgba(0, 0, 0, 0.15);
                z-index: 9999;
                border: 1px solid #e0e0e0;
                overflow: hidden;
                transition: all 0.3s ease;
                display: block;
            }
            #bili-dynamic-progress-panel.collapsed {
                transform: translateX(calc(100% + 20px));
                opacity: 0;
                pointer-events: none;
                visibility: hidden;
            }
            #bili-dynamic-progress-panel:not(.collapsed) {
                transform: translateX(0);
                opacity: 1;
                pointer-events: auto;
                visibility: visible;
            }
            .progress-header {
                background: linear-gradient(135deg, #00a1d6, #008cba);
                color: white;
                padding: 14px 18px;
                display: flex;
                justify-content: space-between;
                align-items: center;
                font-weight: 600;
            }
            .progress-header .title {
                font-size: 16px;
                display: flex;
                align-items: center;
                gap: 8px;
            }
            .progress-header .title::before {
                content: '🎯';
            }
            .progress-header .controls {
                display: flex;
                gap: 8px;
            }
            .progress-header button {
                background: rgba(255, 255, 255, 0.2);
                border: none;
                color: white;
                width: 28px;
                height: 28px;
                border-radius: 6px;
                cursor: pointer;
                display: flex;
                align-items: center;
                justify-content: center;
                font-size: 16px;
                transition: all 0.2s;
                font-weight: bold;
            }
            .progress-header button:hover {
                background: rgba(255, 255, 255, 0.3);
                transform: scale(1.1);
            }
            .progress-body {
                padding: 20px;
            }
            .progress-status {
                margin-bottom: 20px;
            }
            .status-text {
                font-size: 14px;
                color: #666;
                margin-bottom: 8px;
                font-weight: 500;
            }
            .current-status {
                font-size: 16px;
                font-weight: bold;
                color: #00a1d6;
                padding: 8px 14px;
                background: linear-gradient(to right, #f0f7ff, #e6f3ff);
                border-radius: 8px;
                display: inline-block;
                border-left: 4px solid #00a1d6;
                min-width: 180px;
            }
            .stats-grid {
                display: grid;
                grid-template-columns: repeat(2, 1fr);
                gap: 12px;
                margin-bottom: 20px;
            }
            .stat-item {
                background: linear-gradient(135deg, #f8f9fa, #f0f3f5);
                padding: 14px;
                border-radius: 8px;
                text-align: center;
                border: 1px solid #e9ecef;
                transition: transform 0.2s;
            }
            .stat-item:hover {
                transform: translateY(-2px);
                box-shadow: 0 4px 12px rgba(0, 0, 0, 0.05);
            }
            .stat-label {
                font-size: 12px;
                color: #666;
                margin-bottom: 6px;
                font-weight: 500;
            }
            .stat-value {
                font-size: 20px;
                font-weight: bold;
                color: #00a1d6;
            }
            .stat-unit {
                font-size: 12px;
                color: #999;
                margin-left: 2px;
            }
            .detailed-stats {
                background: #f8f9fa;
                border-radius: 8px;
                padding: 15px;
                margin-bottom: 20px;
            }
            .stat-row {
                display: flex;
                justify-content: space-between;
                align-items: center;
                padding: 8px 0;
                border-bottom: 1px solid #eee;
            }
            .stat-row:last-child {
                border-bottom: none;
            }
            .stat-row span:first-child {
                color: #666;
                font-size: 13px;
            }
            .stat-row span:last-child {
                color: #00a1d6;
                font-weight: bold;
                font-size: 14px;
            }
            .progress-time {
                font-size: 13px;
                color: #888;
                text-align: center;
                margin-top: 15px;
                padding-top: 15px;
                border-top: 1px solid #eee;
                font-weight: 500;
            }
            .progress-actions {
                display: grid;
                grid-template-columns: repeat(3, 1fr);
                gap: 10px;
                margin-top: 20px;
            }
            .progress-actions button {
                padding: 10px 12px;
                border: none;
                border-radius: 6px;
                cursor: pointer;
                font-size: 14px;
                font-weight: 500;
                transition: all 0.2s;
                display: flex;
                align-items: center;
                justify-content: center;
                gap: 6px;
            }
            .pause-btn {
                background: #ff9800;
                color: white;
            }
            .pause-btn:hover {
                background: #f57c00;
                transform: translateY(-2px);
            }
            .stop-btn {
                background: #f25d8e;
                color: white;
            }
            .stop-btn:hover {
                background: #e0527f;
                transform: translateY(-2px);
            }
            .hide-details-btn {
                background: #f0f0f0;
                color: #666;
            }
            .hide-details-btn:hover {
                background: #e0e0e0;
            }
            .export-btn {
                background: #4caf50;
                color: white;
                grid-column: span 3;
            }
            .export-btn:hover {
                background: #43a047;
                transform: translateY(-2px);
            }

            /* 进度日志样式 */
            .progress-logs {
                margin-top: 20px;
                max-height: 250px;
                overflow-y: auto;
                border: 1px solid #e0e0e0;
                border-radius: 8px;
                padding: 15px;
                background: #fafafa;
            }
            .progress-logs.hidden {
                display: none;
            }
            .log-item {
                font-size: 12px;
                padding: 8px 12px;
                margin-bottom: 6px;
                border-left: 4px solid #00a1d6;
                background: white;
                border-radius: 4px;
                line-height: 1.4;
            }
            .log-item.error {
                border-left-color: #f25d8e;
                color: #d32f2f;
                background: linear-gradient(to right, #fff5f5, #ffebee);
            }
            .log-item.success {
                border-left-color: #4caf50;
                color: #2e7d32;
                background: linear-gradient(to right, #f1f8e9, #e8f5e9);
            }
            .log-item.warning {
                border-left-color: #ff9800;
                color: #ef6c00;
                background: linear-gradient(to right, #fff3e0, #ffecb3);
            }
            .log-item.info {
                border-left-color: #00a1d6;
                color: #1976d2;
                background: linear-gradient(to right, #e3f2fd, #e1f5fe);
            }
            .log-time {
                color: #999;
                margin-right: 10px;
                font-family: 'Monaco', 'Consolas', monospace;
                font-size: 11px;
                min-width: 70px;
                display: inline-block;
            }

            /* 通知样式 */
            .backup-notification {
                position: fixed;
                top: 20px;
                right: 20px;
                background: white;
                border-left: 5px solid #00a1d6;
                padding: 18px 22px;
                border-radius: 10px;
                box-shadow: 0 8px 32px rgba(0,0,0,0.2);
                z-index: 10000;
                min-width: 320px;
                max-width: 400px;
                animation: slideIn 0.4s cubic-bezier(0.68, -0.55, 0.27, 1.55);
                transition: all 0.3s;
            }
            .backup-notification.success { border-left-color: #4caf50; }
            .backup-notification.warning { border-left-color: #ff9800; }
            .backup-notification.error { border-left-color: #f44336; }
            .backup-notification strong {
                display: block;
                margin-bottom: 8px;
                font-size: 16px;
                color: #333;
            }
            .backup-notification p {
                margin: 5px 0 0 0;
                font-size: 14px;
                color: #666;
                line-height: 1.5;
            }
            @keyframes slideIn {
                from { transform: translateX(100%); opacity: 0; }
                to { transform: translateX(0); opacity: 1; }
            }

            /* 设置项分组 */
            .setting-group {
                margin-bottom: 20px;
                padding: 15px;
                background: #f8f9fa;
                border-radius: 8px;
                border: 1px solid #e9ecef;
            }
            .setting-group-title {
                font-size: 16px;
                font-weight: bold;
                color: #00a1d6;
                margin-bottom: 15px;
                padding-bottom: 8px;
                border-bottom: 2px solid #00a1d6;
                display: flex;
                align-items: center;
                gap: 8px;
            }

            /* 数值输入框样式 */
            input[type="number"] {
                width: 70px;
                padding: 5px 8px;
                border: 1px solid #ddd;
                border-radius: 4px;
                text-align: center;
            }
            input[type="number"]:focus {
                outline: none;
                border-color: #00a1d6;
                box-shadow: 0 0 0 2px rgba(0, 161, 214, 0.2);
            }

            /* 响应式调整 */
            @media (max-width: 768px) {
                #bili-dynamic-progress-panel {
                    width: calc(100% - 40px);
                    right: 20px;
                    left: 20px;
                }
                .setting-content {
                    width: 90%;
                    padding: 20px;
                }
                .progress-actions {
                    grid-template-columns: 1fr;
                }
                .backup-notification {
                    min-width: calc(100% - 40px);
                    right: 20px;
                    left: 20px;
                }
            }
        `;
        document.head.appendChild(style);
    }

    // ========== 进度面板管理 ==========

    function createProgressPanel() {
        const oldPanel = document.getElementById('bili-dynamic-progress-panel');
        if (oldPanel) {
            oldPanel.remove();
        }

        const panel = document.createElement('div');
        panel.id = 'bili-dynamic-progress-panel';
        panel.className = 'collapsed';

        panel.innerHTML = `
            <div class="progress-header">
                <div class="title">动态清理进度</div>
                <div class="controls">
                    <button class="close-panel-btn" title="关闭">×</button>
                </div>
            </div>
            <div class="progress-body">
                <div class="progress-status">
                    <div class="status-text">当前状态：</div>
                    <div class="current-status" id="progress-current-status">等待中</div>
                </div>

                <div class="stats-grid">
                    <div class="stat-item">
                        <div class="stat-label">当前模式</div>
                        <div class="stat-value" id="progress-mode">-</div>
                    </div>
                    <div class="stat-item">
                        <div class="stat-label">处理页数</div>
                        <div class="stat-value" id="progress-pages">0</div>
                    </div>
                    <div class="stat-item">
                        <div class="stat-label">已处理动态</div>
                        <div class="stat-value" id="progress-processed">0</div>
                    </div>
                    <div class="stat-item">
                        <div class="stat-label">已删除动态</div>
                        <div class="stat-value" id="progress-deleted">0</div>
                    </div>
                </div>

                <div class="detailed-stats">
                    <div class="stat-row">
                        <span>取关用户：</span>
                        <span id="progress-unfollowed">0</span>
                    </div>
                    <div class="stat-row">
                        <span>删除记录：</span>
                        <span id="progress-details-count">0 条</span>
                    </div>
                </div>

                <div class="progress-time">
                    <span id="progress-time">运行时间: 00:00</span>
                </div>

                <div class="progress-logs" id="progress-logs"></div>

                <div class="progress-actions">
                    <button class="pause-btn">⏸️ 暂停</button>
                    <button class="stop-btn">⏹️ 停止</button>
                    <button class="hide-details-btn">📋 隐藏详情</button>
                    <button class="export-btn">📊 导出报告</button>
                </div>
            </div>
        `;

        document.body.appendChild(panel);

        panel.querySelector('.close-panel-btn').addEventListener('click', function(e) {
            e.preventDefault();
            e.stopPropagation();
            hideProgressPanel();
        });
        panel.querySelector('.pause-btn').addEventListener('click', togglePause);
        panel.querySelector('.stop-btn').addEventListener('click', stopProcessing);
        panel.querySelector('.hide-details-btn').addEventListener('click', hideProgressDetails);
        panel.querySelector('.export-btn').addEventListener('click', function(e) {
            e.preventDefault();
            e.stopPropagation();
            exportReport();
        });

        console.log('进度面板已创建（默认隐藏）');
        return panel;
    }

    function showProgressPanel() {
        console.log('通过菜单命令显示进度面板...');
        let panel = document.getElementById('bili-dynamic-progress-panel');
        if (!panel) {
            console.log('面板不存在，创建新面板');
            panel = createProgressPanel();
        }

        panel.style.display = 'block';
        panel.style.visibility = 'visible';
        panel.style.opacity = '1';
        panel.style.transform = 'translateX(0)';
        panel.classList.remove('collapsed');

        console.log('进度面板已显示');
        updateProgressDisplay();

        return panel;
    }

    function hideProgressPanel() {
        const panel = document.getElementById('bili-dynamic-progress-panel');
        if (panel) {
            panel.remove();
            console.log('进度面板已关闭（任务继续在后台运行）');
            sendNotification('进度面板已关闭，任务继续在后台运行。可通过菜单"显示进度面板"重新打开。', 'info');
        }
    }

    function hideProgressDetails() {
        const logs = document.getElementById('progress-logs');
        const btn = document.querySelector('.hide-details-btn');
        if (logs && btn) {
            logs.classList.toggle('hidden');
            btn.textContent = logs.classList.contains('hidden') ? '📋 显示详情' : '📋 隐藏详情';
        }
    }

    function togglePause() {
        if (!isTaskActive()) return;
        isPaused = !isPaused;
        progressData.currentStatus = isPaused ? '已暂停' : '正在运行';
        updateProgressDisplay();
        addProgressLog(isPaused ? '处理已暂停' : '处理已继续', isPaused ? 'warning' : 'info');

        const pauseBtn = document.querySelector('.pause-btn');
        if (pauseBtn) {
            pauseBtn.innerHTML = isPaused ? '▶️ 继续' : '⏸️ 暂停';
        }
    }

    function updateProgressDisplay() {
        const panel = document.getElementById('bili-dynamic-progress-panel');
        if (!panel) return;

        const statusEl = document.getElementById('progress-current-status');
        if (statusEl) statusEl.textContent = progressData.currentStatus;

        const modeEl = document.getElementById('progress-mode');
        if (modeEl) modeEl.textContent = progressData.mode || '-';

        const pagesEl = document.getElementById('progress-pages');
        if (pagesEl) pagesEl.textContent = progressData.currentPage;

        const processedEl = document.getElementById('progress-processed');
        if (processedEl) processedEl.textContent = progressData.processedItems;

        const deletedEl = document.getElementById('progress-deleted');
        if (deletedEl) deletedEl.textContent = progressData.deletedItems;

        const unfollowedEl = document.getElementById('progress-unfollowed');
        if (unfollowedEl) unfollowedEl.textContent = progressData.unfollowedUsers;

        const detailsCountEl = document.getElementById('progress-details-count');
        if (detailsCountEl) {
            detailsCountEl.textContent = `${progressData.deletedDetails.length} 条`;
        }

        const timeEl = document.getElementById('progress-time');
        if (timeEl && progressData.startTime) {
            const elapsed = (progressData.endTime || Date.now()) - progressData.startTime;
            timeEl.textContent = `运行时间: ${formatTime(elapsed)}`;
        }
    }


    function addProgressLog(message, type = 'info', dynamicId = null) {
        const now = new Date();
        const logsContainer = document.getElementById('progress-logs');
        if (logsContainer) {
            const shouldScroll = logsContainer.scrollHeight - logsContainer.scrollTop - logsContainer.clientHeight < 40;
            const logItem = document.createElement('div');
            logItem.className = `log-item ${type}`;
            const time = document.createElement('span');
            time.className = 'log-time';
            time.textContent = now.toLocaleTimeString();
            const text = document.createElement('span');
            text.className = 'log-message';
            text.textContent = dynamicId ? `[动态ID: ${dynamicId}] ${message}` : String(message);
            logItem.append(time, text);
            logsContainer.appendChild(logItem);
            while (logsContainer.children.length > CONFIG.MAX_VISIBLE_LOGS) logsContainer.firstElementChild.remove();
            if (shouldScroll) logsContainer.scrollTop = logsContainer.scrollHeight;
        }
        progressData.logs.push({ timestamp: now, message, type, dynamicId });
        if (progressData.logs.length > CONFIG.MAX_STORED_LOGS) {
            progressData.logs.splice(0, progressData.logs.length - CONFIG.MAX_STORED_LOGS);
        }
    }

    function addDeleteRecord(data, reason) {
        const content = getDynamicContent(data);

        const record = {
            timestamp: new Date().toLocaleString(),
            dynamicId: data.id_str || '未知',
            content: content,
            reason: reason,
            type: data.type || '未知'
        };

        progressData.deletedDetails.push(record);

        const detailsCountEl = document.getElementById('progress-details-count');
        if (detailsCountEl) {
            detailsCountEl.textContent = `${progressData.deletedDetails.length} 条`;
        }

        addProgressLog(`删除记录: ${content.substring(0, 50)}...`, 'success', data.id_str);

        return record;
    }

    function initProgressData(mode) {
        progressData = {
            currentPage: 0,
            processedItems: 0,
            deletedItems: 0,
            unfollowedUsers: 0,
            currentStatus: '初始化...',
            mode: mode,
            startTime: Date.now(),
            endTime: null,
            deletedDetails: [],
            unfollowedDetails: [],
            unfollowFailedDetails: [],
            logs: []
        };

        const logsContainer = document.getElementById('progress-logs');
        if (logsContainer) {
            logsContainer.innerHTML = '';
            logsContainer.classList.remove('hidden');
        }

        const pauseBtn = document.querySelector('.pause-btn');
        if (pauseBtn) {
            pauseBtn.innerHTML = '⏸️ 暂停';
        }

        const hideDetailsBtn = document.querySelector('.hide-details-btn');
        if (hideDetailsBtn) {
            hideDetailsBtn.innerHTML = '📋 隐藏详情';
        }

        updateProgressDisplay();
        addProgressLog(`开始执行 ${mode} 模式...`, 'info');
        addProgressLog(`抽奖API重试次数: ${getLotteryApiRetries()} 次`, 'info');
    }

    // ========== 报告和导出 ==========

    function generateReport() {
        const totalTime = progressData.startTime ? (progressData.endTime || Date.now()) - progressData.startTime : 0;
        const minutes = Math.floor(totalTime / 60000);
        const seconds = Math.floor((totalTime % 60000) / 1000);

        // 删除的动态详情
        let deletedDetailsText = '';
        if (progressData.deletedDetails.length > 0) {
            deletedDetailsText = '\n\n========== 删除的动态详情 ==========\n';

            progressData.deletedDetails.forEach((record, index) => {
                deletedDetailsText += `\n[${index + 1}] ${record.timestamp}\n`;
                deletedDetailsText += `   动态ID: ${record.dynamicId}\n`;
                deletedDetailsText += `   删除原因: ${record.reason}\n`;
                deletedDetailsText += `   动态类型: ${record.type}\n`;
                deletedDetailsText += `   内容摘要: ${record.content}\n`;
                deletedDetailsText += `   ${'-'.repeat(40)}`;
            });

            deletedDetailsText += `\n\n共删除 ${progressData.deletedDetails.length} 条动态`;
        } else {
            deletedDetailsText = '\n\n本次执行未删除任何动态。';
        }

        // 取关UP主详情
        let unfollowDetailsText = '';
        // 成功取关
        if (progressData.unfollowedDetails && progressData.unfollowedDetails.length > 0) {
            unfollowDetailsText += '\n\n========== 成功取关的UP主 ==========\n';
            progressData.unfollowedDetails.forEach((record, index) => {
                unfollowDetailsText += `\n[${index + 1}] ${record.timestamp}\n`;
                unfollowDetailsText += `   用户名: ${record.name}\n`;
                unfollowDetailsText += `   UID: ${record.uid}\n`;
                unfollowDetailsText += `   ${'-'.repeat(40)}`;
            });
            unfollowDetailsText += `\n\n共成功取关 ${progressData.unfollowedDetails.length} 个UP主`;
        } else {
            unfollowDetailsText += '\n\n本次执行未成功取关任何UP主。';
        }

        // 取关失败
        if (progressData.unfollowFailedDetails && progressData.unfollowFailedDetails.length > 0) {
            unfollowDetailsText += '\n\n========== 取关失败的UP主 ==========\n';
            progressData.unfollowFailedDetails.forEach((record, index) => {
                unfollowDetailsText += `\n[${index + 1}] ${record.timestamp}\n`;
                unfollowDetailsText += `   用户名: ${record.name}\n`;
                unfollowDetailsText += `   UID: ${record.uid}\n`;
                unfollowDetailsText += `   失败原因: ${record.reason}\n`;
                unfollowDetailsText += `   ${'-'.repeat(40)}`;
            });
            unfollowDetailsText += `\n\n共失败 ${progressData.unfollowFailedDetails.length} 个UP主`;
        } else {
            if (!(progressData.unfollowedDetails && progressData.unfollowedDetails.length > 0)) {
                unfollowDetailsText += '\n\n本次执行没有取关失败的UP主。';
            }
        }

        // 构建完整报告
        const report = `
╔══════════════════════════════════════╗
║      B站动态清理执行报告            ║
╠══════════════════════════════════════╣
║ 执行模式：${progressData.mode.padEnd(20)} ║
║ 运行时间：${minutes}分${seconds}秒${' '.repeat(12)} ║
║ API重试：${getLotteryApiRetries()}次${' '.repeat(15)} ║
╠══════════════════════════════════════╣
║ 处理页数：${progressData.currentPage.toString().padEnd(20)} ║
║ 处理动态：${progressData.processedItems.toString().padEnd(20)} ║
║ 删除动态：${progressData.deletedItems.toString().padEnd(20)} ║
║ 取关用户：${progressData.unfollowedUsers.toString().padEnd(20)} ║
╚══════════════════════════════════════╝

执行状态：${progressData.currentStatus}
执行时间：${new Date().toLocaleString()}
脚本版本：${GM_info.script.version}
${deletedDetailsText}
${unfollowDetailsText}

注意事项：
1. 删除的动态无法恢复，请谨慎操作
2. 建议定期清理已开奖的动态
3. 如遇问题，请检查网络连接和登录状态
`;

        console.log(report);
        return report;
    }

    function exportReport() {
        try {
            console.log('开始导出报告...');
            const report = generateReport();
            const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
            const filename = `B站动态清理报告_${timestamp}.txt`;

            if (typeof GM_download !== 'undefined') {
                try {
                    console.log('使用GM_download导出报告');
                    const dataUri = 'data:text/plain;charset=utf-8,' + encodeURIComponent(report);

                    GM_download({
                        url: dataUri,
                        name: `${String(GM_getValue('export-path', 'BiliDynamicCleaner')).replace(/[\\/:*?"<>|.]/g, '_') || 'BiliDynamicCleaner'}/${filename}`,
                        saveAs: true,
                        onload: function() {
                            console.log('报告导出成功');
                            addProgressLog(`报告已导出: ${filename}`, 'success');
                            sendNotification('报告导出成功', 'success');
                        },
                        onerror: function(error) {
                            console.error('GM_download失败:', error);
                            fallbackToConsole(report, filename, error);
                        }
                    });
                } catch (gmError) {
                    console.error('GM_download异常:', gmError);
                    fallbackToConsole(report, filename, gmError);
                }
            } else {
                console.warn('GM_download不可用，使用控制台输出');
                fallbackToConsole(report, filename, new Error('GM_download不可用'));
            }
        } catch (error) {
            console.error('导出报告失败:', error);
            addProgressLog(`报告导出失败: ${error.message}`, 'error');
            sendNotification('报告导出失败: ' + error.message, 'error');
        }
    }

    function fallbackToConsole(report, filename, error) {
        console.log(`\n========== B站动态清理报告 ==========`);
        console.log(`文件名建议: ${filename}`);
        console.log(`下载失败原因:`, error);
        console.log(`\n报告内容:`);
        console.log(report);
        console.log(`========== 报告结束 ==========\n`);

        addProgressLog('GM_download失败，报告内容已输出到控制台，请手动复制保存', 'warning');
        sendNotification('GM_download失败，请查看浏览器控制台(F12)获取报告内容', 'warning');
    }

    // ========== 核心功能 ==========


    async function getDynamics(duid, offset, mode, input) {
        if (isRunning) return;
        isRunning = true;
        isPaused = false;
        runController = new AbortController();
        runFailure = null;
        mutationQueue = Promise.resolve();
        lastMutationTime = 0;
        lotteryCache.clear();
        seenDynamics.clear();
        const criteria = {
            users: new Set(mode === 'user' ? input.split(',').map(user => user.trim()).filter(Boolean) : []),
            days: mode === 'days_ago' ? Number(input) : null,
            targetDate: mode === 'days_ago' ? getBeforeDate(Number(input)) : null,
            unfollow: Boolean(GM_getValue('set-unfollow')),
            autoPause: Boolean(GM_getValue('auto-pause'))
        };
        try {
            initProgressData(mode);
            showProgressPanel();
            progressTimer = setInterval(updateProgressDisplay, 1000);
            const seenOffsets = new Set();
            let complete = false;
            while (await waitUntilReady()) {
                const cursor = String(offset ?? '');
                if (seenOffsets.has(cursor)) throw new Error('分页游标重复，已终止以避免重复处理');
                seenOffsets.add(cursor);
                progressData.currentPage++;
                progressData.currentStatus = `正在处理第 ${progressData.currentPage} 页...`;
                updateProgressDisplay();
                const result = await processDynamicPage(duid, cursor, mode, criteria, progressData.currentPage);
                if (!isTaskActive()) break;
                if (!result.hasMore) {
                    complete = true;
                    break;
                }
                if (!result.nextOffset || seenOffsets.has(result.nextOffset)) throw new Error('分页未返回新的游标，已终止');
                offset = result.nextOffset;
                if (criteria.autoPause && progressData.currentPage % 10 === 0 && !isPaused) {
                    togglePause();
                    addProgressLog(`已处理 ${progressData.currentPage} 页，自动暂停，请手动继续。`, 'warning');
                }
                await sleep(CONFIG.REQUEST_DELAY);
            }
            if (complete && isTaskActive()) {
                if (criteria.unfollow) {
                    progressData.currentStatus = '正在取关用户...';
                    updateProgressDisplay();
                    await unfollowUser();
                }
                if (isTaskActive()) {
                    progressData.currentStatus = '处理完成';
                    addProgressLog('所有动态处理完成！', 'success');
                    sendNotification('动态清理完成', 'success');
                }
            }
        } catch (error) {
            const failure = runFailure || (!isCancellation(error) ? error : null);
            if (failure) {
                progressData.currentStatus = '处理出错';
                addProgressLog(`处理已终止: ${failure.message}`, 'error');
                sendNotification(`处理已终止: ${failure.message}`, 'error');
            }
        } finally {
            await mutationQueue;
            clearInterval(progressTimer);
            progressTimer = null;
            if (runFailure) progressData.currentStatus = '处理出错';
            else if (runController.signal.aborted) progressData.currentStatus = '已停止';
            progressData.endTime = Date.now();
            isRunning = false;
            isPaused = false;
            lotteryCache.clear();
            seenDynamics.clear();
            updateProgressDisplay();
            const pauseBtn = document.querySelector('.pause-btn');
            if (pauseBtn) pauseBtn.textContent = '⏸️ 暂停';
        }
    }

    async function processDynamicPage(duid, offset, mode, criteria, pageNum) {
        const body = await requestWithRetry({
            url: 'https://api.bilibili.com/x/polymer/web-dynamic/v1/feed/space',
            params: { offset, host_mid: duid }
        });
        if (!body.data) throw new Error(`第 ${pageNum} 页数据格式无效`);
        const noMore = [false, 0, '0'].includes(body.data.has_more);
        const items = body.data.items == null && noMore ? [] : body.data.items;
        if (!Array.isArray(items)) throw new Error(`第 ${pageNum} 页动态列表格式无效`);
        if (body.data.has_more !== undefined && ![true, false, 1, 0, '1', '0'].includes(body.data.has_more)) {
            throw new Error(`第 ${pageNum} 页分页标记无效`);
        }
        const nextOffset = String(body.data.offset ?? '');
        const hasMore = body.data.has_more === undefined ? Boolean(nextOffset && items.length) :
            [true, 1, '1'].includes(body.data.has_more);
        addProgressLog(`第 ${pageNum} 页获取到 ${items.length} 条动态`, 'info');
        for (let i = 0; i < items.length; i += CONFIG.BATCH_SIZE) {
            if (!await waitUntilReady()) break;
            progressData.currentStatus = `处理第 ${pageNum} 页, 第 ${Math.floor(i / CONFIG.BATCH_SIZE) + 1} 批`;
            updateProgressDisplay();
            await processDynamicBatch(items.slice(i, i + CONFIG.BATCH_SIZE), mode, criteria);
        }
        return { nextOffset, hasMore };
    }

    async function processDynamicBatch(batch, mode, criteria) {
        const items = batch.filter(data => {
            const id = data?.id_str;
            if (!id || seenDynamics.has(String(id))) return false;
            seenDynamics.add(String(id));
            return true;
        });
        const results = await Promise.allSettled(items.map(data => processSingleDynamic(data, mode, criteria)));
        const processed = results.filter(result => result.status === 'fulfilled').length;
        const deleted = results.filter(result => result.status === 'fulfilled' && result.value).length;
        const failures = results.filter(result => result.status === 'rejected' && !isCancellation(result.reason));
        progressData.processedItems += processed + failures.length;
        updateProgressDisplay();
        if (runFailure) throw runFailure;
        if (isTaskActive() && items.length) addProgressLog(`批次完成: 处理 ${processed} 条, 删除 ${deleted} 条, 失败 ${failures.length} 条`, failures.length ? 'warning' : 'info');
        return { processed, deleted, failures: failures.length };
    }

    async function processSingleDynamic(data, mode, criteria) {
        if (!await waitUntilReady()) throw cancellationError();
        const dynamicId = data.id_str;
        // 删除边界只允许明确标记为转发的动态。
        if (!['DYNAMIC_TYPE_FORWARD', 'FORWARD'].includes(data.type)) return false;
        const original = data.orig;
        const author = original?.modules?.module_author;
        let reason;
        if (mode === 'user') {
            if (!author || !criteria.users.has(author.name) && !criteria.users.has(String(author.mid))) return false;
            reason = `指定用户: ${author.name || author.mid}`;
        } else {
            if (mode === 'days_ago') {
                const date = getForwardDynamicDate(data);
                if (!date.success) {
                    addProgressLog('转发日期缺失或无效，跳过', 'warning', dynamicId);
                    return false;
                }
                if (date.date > criteria.targetDate) return false;
            }
            // 原动态缺失或占位对象没有ID，均按已删除的源动态处理。
            if (!original?.id_str) {
                reason = mode === 'auto' ? '源动态已被删除' : `日期筛选(${criteria.days}天前)的已删除源动态`;
            } else {
                const lottery = await checkLotteryStatus(original.id_str);
                if (!lottery.success) {
                    addProgressLog(`抽奖状态查询失败，跳过: ${lottery.error.message}`, 'error', dynamicId);
                    return false;
                }
                if (lottery.isLottery && lottery.status !== 2) return false;
                if (mode === 'auto' && !lottery.isLottery) return false;
                reason = mode === 'auto' ? '源动态已开奖' :
                    `日期筛选(${criteria.days}天前)的${lottery.isLottery ? '已开奖' : '非抽奖'}动态`;
            }
        }
        const deleted = await deleteDynamic(data, reason);
        if (deleted) {
            progressData.deletedItems++;
            if (criteria.unfollow && [true, 1, '1'].includes(author?.following)) saveUnfollowUser(data);
            updateProgressDisplay();
        }
        return deleted;
    }

    async function deleteDynamic(item, reason) {
        if (!await waitUntilReady()) throw cancellationError();
        const csrf = getCSRFToken();
        if (!csrf) {
            const error = new Error('CSRF token缺失，请重新登录');
            error.fatal = true;
            runFailure = error;
            runController.abort();
            throw error;
        }
        try {
            const body = await requestWithRetry({
                method: 'post',
                url: 'https://api.bilibili.com/x/dynamic/feed/operate/remove',
                params: { platform: 'web', csrf },
                data: { dyn_id_str: item.id_str, dyn_type: 1, rid_str: item.id_str },
                headers: { 'Content-Type': 'application/json' }
            }, CONFIG.MAX_RETRIES, true, [0, -404]);
            if (Number(body.code) === -404) {
                addProgressLog('动态已不存在，不计入本次删除，也不添加取关', 'warning', item.id_str);
                return false;
            }
            addDeleteRecord(item, reason);
            return true;
        } catch (error) {
            if (isCancellation(error) || error.fatal) throw error;
            addProgressLog(`删除失败: ${error.message}`, 'error', item.id_str);
            throw error;
        }
    }

    function saveUnfollowUser(data) {
        const author = data.orig?.modules?.module_author;
        const uid = String(author?.mid ?? '');
        if (!/^[1-9]\d*$/.test(uid)) return;
        const users = getUnfollowList();
        if (!users.some(user => user.uid === uid)) {
            users.push({ uid, name: String(author.name || uid) });
            GM_setValue('unfollow-list', users);
        }
    }

    async function unfollowUser() {
        const users = getUnfollowList();
        GM_setValue('unfollow-list', users);
        if (!users.length) return;
        addProgressLog(`开始取关 ${users.length} 个用户...`, 'info');
        for (const user of users) {
            if (!await waitUntilReady()) break;
            try {
                const csrf = getCSRFToken();
                if (!csrf) {
                    const error = new Error('CSRF token缺失，请重新登录');
                    error.fatal = true;
                    runFailure = error;
                    runController.abort();
                    throw error;
                }
                await requestWithRetry({
                    method: 'post',
                    url: 'https://api.bilibili.com/x/relation/modify',
                    data: new URLSearchParams({ fid: user.uid, act: '2', re_src: '11', spmid: '333.999.0.0', csrf }),
                    headers: { 'Content-Type': 'application/x-www-form-urlencoded' }
                }, CONFIG.MAX_RETRIES, true);
                // 每次成功即保存；失败及尚未执行的用户留在队列。
                GM_setValue('unfollow-list', getUnfollowList().filter(item => item.uid !== user.uid));
                progressData.unfollowedUsers++;
                progressData.unfollowedDetails.push({ ...user, timestamp: new Date().toLocaleString() });
                addProgressLog(`取关成功: ${user.name} (${user.uid})`, 'success');
                updateProgressDisplay();
            } catch (error) {
                if (isCancellation(error)) break;
                progressData.unfollowFailedDetails.push({ ...user, timestamp: new Date().toLocaleString(), reason: error.message });
                if (error.fatal) throw error;
                addProgressLog(`取关失败，已保留待重试: ${user.name} (${user.uid}) - ${error.message}`, 'error');
            }
        }
        addProgressLog(`取关结束，待取关列表剩余 ${getUnfollowList().length} 个用户`, 'info');
    }


    function stopProcessing() {
        if (!isTaskActive()) return;
        runController.abort();
        isPaused = false;
        progressData.currentStatus = '正在停止...';
        updateProgressDisplay();
        addProgressLog('用户停止了处理，正在取消请求和等待', 'warning');
        sendNotification('已请求停止处理', 'warning');
    }

    function sendNotification(msg, type = 'info') {
        const notificationTypes = {
            info: { title: '信息', timeout: 4000 },
            success: { title: '成功', timeout: 5000 },
            warning: { title: '警告', timeout: 6000 },
            error: { title: '错误', timeout: 8000 }
        };

        const config = notificationTypes[type] || notificationTypes.info;

        try {
            GM_notification({
                text: msg,
                title: `${GM_info.script.name} - ${config.title}`,
                image: GM_info.script.icon,
                timeout: config.timeout,
                silent: type !== 'error',
                onclick: () => showProgressPanel()
            });
        } catch (e) {
            console.log(`[${type.toUpperCase()}] ${msg}`);
        }
    }

    // ========== 启动和菜单 ==========

    async function start(mode) {
        if (isRunning) {
            sendNotification('已有任务在执行中，请等待完成');
            return false;
        }

        if (!['auto', 'user', 'days_ago'].includes(mode)) return false;
        const duid = getUserID();

        if (!duid || !getCSRFToken()) {
            sendNotification('未检测到登录状态，请先登录B站。', 'error');
            return false;
        }

        let input = '';

        if (mode === 'user') {
            input = prompt('请输入想要删除的用户名或 UID (多个则用英文逗号「,」进行分割):\n例如: 张三,123456,李四\n\n注意：区分大小写，请确保输入准确。');
            if (!input || input.trim() === '') {
                sendNotification('没有输入内容！', 'warning');
                return false;
            }
            input = input.split(',').map(user => user.trim()).filter(Boolean).join(',');
            if (!input) {
                sendNotification('请输入至少一个用户名或UID', 'warning');
                return false;
            }
        }

        if (mode === 'days_ago') {
            input = prompt('请输入想要删除多少天前的动态 (正整数):\n例如: 30 (删除30天前的动态)\n\n注意：会尝试获取您转发该动态的日期，日期字段无效时会跳过该动态。抽奖API失败会重试' + getLotteryApiRetries() + '次。');
            input = input?.trim();
            if (!input || !/^[1-9]\d*$/.test(input) || !Number.isSafeInteger(Number(input)) || !Number.isFinite(new Date(Date.now() - Number(input) * 86400000).getTime())) {
                sendNotification('输入错误！请输入正整数。', 'error');
                return false;
            }
        }

        // 直接构建警告信息，不再尝试获取动态总数
        let warningMsg = `抽奖API重试次数: ${getLotteryApiRetries()} 次`;

        if (mode === 'days_ago') {
            warningMsg += `\n\n日期筛选说明: 将判断您转发该动态的日期，日期字段无效时会跳过该动态。`;
        }

        warningMsg += '\n\n注意：这将删除符合条件的转发动态，操作不可撤销！';

        if (!confirm(`确定要开始执行"${mode}"模式吗？\n\n${warningMsg}`)) {
            return false;
        }

        console.log(`开始执行模式: ${mode}, 参数: ${input}`);

        console.log('启动任务前显示进度面板');
        showProgressPanel();

        await getDynamics(duid, '', mode, input);
        return true;
    }

    function registerMenuCommands() {
        if (menuCommandsRegistered) {
            return;
        }

        GM_registerMenuCommand('🚀 自动判断模式', () => {
            start('auto');
        }, 'A');

        GM_registerMenuCommand('👤 指定用户模式', () => {
            start('user');
        }, 'U');

        GM_registerMenuCommand('📅 日期筛选模式', () => {
            start('days_ago');
        }, 'D');

        GM_registerMenuCommand('⚙️ 打开设置', () => {
            openSettingWindow();
        }, 'S');

        GM_registerMenuCommand('📋 查看取关列表', () => {
            let unfollow_list = getUnfollowList();
            if (unfollow_list.length === 0) {
                sendNotification('取关列表为空。', 'info');
            } else {
                sendNotification(`取关列表中有 ${unfollow_list.length} 个用户`, 'info');
                console.log('取关列表:', unfollow_list);
            }
        }, 'L');

        GM_registerMenuCommand('⏸️ 暂停/继续', () => {
            if (isRunning) {
                togglePause();
            } else {
                sendNotification('当前没有正在执行的任务', 'warning');
            }
        }, 'P');

        GM_registerMenuCommand('⏹️ 停止执行', () => {
            stopProcessing();
        }, 'X');

        GM_registerMenuCommand('📊 导出报告', () => {
            console.log('从菜单点击导出报告');
            exportReport();
        }, 'E');

        GM_registerMenuCommand('📈 显示进度面板', () => {
            console.log('从菜单显示进度面板');
            showProgressPanel();
        }, 'V');

        menuCommandsRegistered = true;
        console.log('菜单命令已注册');
    }

    // ========== 设置窗口 ==========

    function openSettingWindow() {
        if (document.querySelector('.setting-popup')) {
            return;
        }

        let main_window = document.createElement('div');
        main_window.className = 'setting-popup';
        main_window.innerHTML = `
            <div class="setting-content">
                <div class="setting-header">
                    <span>设置</span>
                </div>
                <div class="setting-body">
                    <div class="setting-group">
                        <div class="setting-group-title">⚙️ 基础设置</div>
                        <div class="setting-item">
                            <label for="set-unfollow">
                                启用取关功能
                                <div class="help-text">删除动态后自动取关原作者</div>
                            </label>
                            <div class="checkbox-container">
                                <input type="checkbox" id="set-unfollow" />
                            </div>
                        </div>
                        <div class="setting-item">
                            <label for="auto-pause">
                                自动暂停
                                <div class="help-text">每处理10页自动暂停，需要手动继续</div>
                            </label>
                            <div class="checkbox-container">
                                <input type="checkbox" id="auto-pause" />
                            </div>
                        </div>
                    </div>

                    <div class="setting-group">
                        <div class="setting-group-title">🔧 API设置</div>
                        <div class="setting-item">
                            <label for="lottery-api-retries">
                                抽奖API重试次数
                                <div class="help-text">抽奖API查询失败后的重试次数 (默认: 2)</div>
                            </label>
                            <input type="number" id="lottery-api-retries" min="0" max="5" />
                        </div>
                    </div>

                    <div class="setting-group">
                        <div class="setting-group-title">💾 数据管理</div>
                        <div class="setting-item">
                            <label for="export-path">
                                导出路径
                                <div class="help-text">GM_download保存的子文件夹名称（取决于扩展权限）</div>
                            </label>
                            <input type="text" id="export-path" style="width: 120px; padding: 5px; border: 1px solid #ddd; border-radius: 4px;" />
                        </div>
                        <div class="setting-item">
                            <label>
                                取关列表
                                <div class="help-text">当前有 <span id="unfollow-count">0</span> 个待取关用户</div>
                            </label>
                            <button id="clear-unfollow" style="padding: 6px 12px; background: #f25d8e; color: white; border: none; border-radius: 4px; cursor: pointer;">
                                清空
                            </button>
                        </div>
                    </div>
                </div>
                <div class="setting-footer">
                    <button class="secondary-btn setting-close">取消</button>
                    <button class="primary-btn setting-save">保存设置</button>
                </div>
            </div>
        `;
        document.body.appendChild(main_window);

        const unfollowCheckbox = document.getElementById('set-unfollow');
        const autoPauseCheckbox = document.getElementById('auto-pause');
        const exportPathInput = document.getElementById('export-path');
        const lotteryApiRetriesInput = document.getElementById('lottery-api-retries');
        const unfollowCountSpan = document.getElementById('unfollow-count');

        unfollowCheckbox.checked = GM_getValue('set-unfollow');
        autoPauseCheckbox.checked = GM_getValue('auto-pause');
        exportPathInput.value = GM_getValue('export-path');
        lotteryApiRetriesInput.value = getLotteryApiRetries();

        const unfollowList = getUnfollowList();
        unfollowCountSpan.textContent = unfollowList.length;

        const closeBtn = main_window.querySelector('.setting-close');
        const saveBtn = main_window.querySelector('.setting-save');
        const clearUnfollowBtn = document.getElementById('clear-unfollow');

        closeBtn.addEventListener('click', () => {
            closeSettingWindow();
        });

        saveBtn.addEventListener('click', () => {
            const retriesText = lotteryApiRetriesInput.value.trim();
            const retries = Number(retriesText);
            if (!retriesText || !Number.isInteger(retries) || retries < 0 || retries > 5) {
                sendNotification('抽奖API重试次数必须为0-5之间的整数', 'error');
                return;
            }
            GM_setValue('set-unfollow', unfollowCheckbox.checked);
            GM_setValue('auto-pause', autoPauseCheckbox.checked);
            GM_setValue('export-path', exportPathInput.value.trim() || 'BiliDynamicCleaner');
            GM_setValue('lottery-api-retries', retries);

            sendNotification('设置已保存', 'success');
            closeSettingWindow();
        });

        clearUnfollowBtn.addEventListener('click', () => {
            if (isRunning) {
                sendNotification('请等待任务结束后再清空取关列表', 'warning');
                return;
            }
            if (confirm('确定要清空取关列表吗？')) {
                GM_setValue('unfollow-list', []);
                unfollowCountSpan.textContent = '0';
                sendNotification('取关列表已清空', 'success');
            }
        });

        main_window.addEventListener('click', (e) => {
            if (e.target === main_window) {
                closeSettingWindow();
            }
        });
    }

    function closeSettingWindow() {
        const popup = document.querySelector('.setting-popup');
        if (popup) {
            document.body.removeChild(popup);
        }
    }

    // ========== 初始化和清理 ==========

    function initScript() {
        console.log('Bili.Dynamic.AutoDel Pro (修复删除问题版) 脚本初始化 v' + GM_info.script.version);

        initSettings();
        addStylesOnce();

        createProgressPanel();

        if (document.readyState === 'complete' || document.readyState === 'interactive') {
            console.log('文档已就绪，注册菜单命令');
            registerMenuCommands();
        } else {
            setTimeout(() => {
                console.log('延迟注册菜单命令');
                registerMenuCommands();
            }, 1000);
        }

        console.log('页面右下角图标已禁用，请使用Tampermonkey菜单进行操作');
        console.log(`抽奖API重试次数: ${getLotteryApiRetries()} 次`);
    }

    function cleanup() {
        const progressPanel = document.getElementById('bili-dynamic-progress-panel');
        if (progressPanel) {
            progressPanel.remove();
        }

        closeSettingWindow();

        const styles = document.getElementById('bili-dynamic-autodel-styles');
        if (styles) {
            styles.remove();
        }

        window.biliDynamicAutoDelLoaded = false;
        menuCommandsRegistered = false;
        runController?.abort();
        clearInterval(progressTimer);
        isRunning = false;
        isPaused = false;
    }

    window.addEventListener('beforeunload', cleanup);

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', initScript);
    } else {
        setTimeout(initScript, 1000);
    }
})();
