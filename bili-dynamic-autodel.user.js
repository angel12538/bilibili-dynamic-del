// ==UserScript==
// @name         B站动态自动清理
// @namespace    https://github.com/
// @version      2026.3.8
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
        MEMORY_CLEANUP_INTERVAL: 10,
        LOTTERY_API_TIMEOUT: 8000
    };

    // ========== 执行状态管理 ==========
    let isRunning = false;
    let isPaused = false;
    let retryCounts = {};
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
        logs: []
    };

    // ========== 工具函数 ==========

    // 获取抽奖API重试次数
    function getLotteryApiRetries() {
        const retries = GM_getValue('lottery-api-retries');
        if (retries === undefined) {
            return 2;
        }
        return parseInt(retries, 10);
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

    function mapDynamicType(dynamicType) {
        const typeMap = {
            'DYNAMIC_TYPE_FORWARD': 1,
            'DYNAMIC_TYPE_AV': 8,
            'DYNAMIC_TYPE_DRAW': 2,
            'DYNAMIC_TYPE_WORD': 4,
            'DYNAMIC_TYPE_ARTICLE': 64,
            'DYNAMIC_TYPE_MUSIC': 256,
            'DYNAMIC_TYPE_LIVE_RCMD': 2048,
            2: 1,
            4: 8,
            8: 64,
            64: 4,
            2048: 2048,
            4097: 1
        };

        // 如果是字符串类型的转发，直接返回1
        if (dynamicType === 'DYNAMIC_TYPE_FORWARD' || dynamicType === 'FORWARD') {
            return 1;
        }

        return typeMap[dynamicType] || 1;
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
        return new Promise(resolve => setTimeout(resolve, ms));
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
    async function getForwardDynamicDateWithRetry(data, dynamicId, maxRetries = 3) {
        let retryCount = 0;

        while (retryCount < maxRetries) {
            try {
                let forwardTimestamp = null;

                if (data.modules && data.modules.module_author && data.modules.module_author.pub_ts) {
                    forwardTimestamp = data.modules.module_author.pub_ts;
                    console.log(`获取到转发动态日期 (重试 ${retryCount}): 通过 module_author.pub_ts = ${forwardTimestamp}`);
                } else if (data.modules && data.modules.module_author && data.modules.module_author.pubtime) {
                    forwardTimestamp = data.modules.module_author.pubtime;
                    console.log(`获取到转发动态日期 (重试 ${retryCount}): 通过 module_author.pubtime = ${forwardTimestamp}`);
                } else if (data.pub_ts) {
                    forwardTimestamp = data.pub_ts;
                    console.log(`获取到转发动态日期 (重试 ${retryCount}): 通过 data.pub_ts = ${forwardTimestamp}`);
                } else if (data.pubtime) {
                    forwardTimestamp = data.pubtime;
                    console.log(`获取到转发动态日期 (重试 ${retryCount}): 通过 data.pubtime = ${forwardTimestamp}`);
                } else if (data.ctime) {
                    forwardTimestamp = data.ctime;
                    console.log(`获取到转发动态日期 (重试 ${retryCount}): 通过 data.ctime = ${forwardTimestamp}`);
                } else if (data.timestamp) {
                    forwardTimestamp = data.timestamp;
                    console.log(`获取到转发动态日期 (重试 ${retryCount}): 通过 data.timestamp = ${forwardTimestamp}`);
                }

                if (forwardTimestamp) {
                    const forwardDate = timestampToDate(forwardTimestamp);
                    console.log(`动态 ${dynamicId}: 成功获取转发日期 ${forwardDate} (时间戳: ${forwardTimestamp})`);
                    return {
                        success: true,
                        timestamp: forwardTimestamp,
                        date: forwardDate,
                        retries: retryCount
                    };
                }

                retryCount++;
                if (retryCount < maxRetries) {
                    console.log(`动态 ${dynamicId}: 未找到转发日期，${CONFIG.RETRY_DELAY/1000}秒后重试 (${retryCount}/${maxRetries})`);
                    await sleep(CONFIG.RETRY_DELAY);
                }

            } catch (error) {
                retryCount++;
                console.log(`动态 ${dynamicId}: 获取转发日期时出错: ${error.message} (重试 ${retryCount}/${maxRetries})`);
                if (retryCount < maxRetries) {
                    await sleep(CONFIG.RETRY_DELAY);
                }
            }
        }

        console.log(`动态 ${dynamicId}: 获取转发日期失败，已达到最大重试次数 ${maxRetries}`);
        return {
            success: false,
            timestamp: null,
            date: null,
            retries: retryCount
        };
    }

    // 优化后的抽奖状态检查函数，带重试机制
    async function checkLotteryStatus(dynamicId, index) {
        const api = {
            url: `https://api.vc.bilibili.com/lottery_svr/v1/lottery_svr/lottery_notice?business_type=4&business_id=${dynamicId}`,
            name: '抽奖API'
        };

        let retryCount = 0;
        const maxRetries = getLotteryApiRetries();

        while (retryCount <= maxRetries) {
            try {
                console.log(`抽奖API请求 (重试 ${retryCount}/${maxRetries}): ${api.url}`);

                const response = await axios({
                    url: api.url,
                    timeout: CONFIG.LOTTERY_API_TIMEOUT,
                    headers: {
                        'User-Agent': navigator.userAgent,
                        'Referer': 'https://www.bilibili.com/',
                        'Origin': 'https://www.bilibili.com'
                    },
                    withCredentials: true
                });

                console.log(`抽奖API响应 (${dynamicId}, 重试 ${retryCount}):`, {
                    code: response.data.code,
                    message: response.data.message,
                    data: response.data.data
                });

                if (response.data.code === 0) {
                    if (response.data.data) {
                        let status = response.data.data.status;
                        let isLottery = true;

                        if (status === null || status === undefined) {
                            isLottery = false;
                            status = '非抽奖';
                        }

                        return {
                            success: true,
                            apiUsed: api.name,
                            isLottery: isLottery,
                            status: status,
                            rawData: response.data.data,
                            retries: retryCount
                        };
                    } else {
                        return {
                            success: true,
                            apiUsed: api.name,
                            isLottery: false,
                            status: '非抽奖',
                            rawData: null,
                            retries: retryCount
                        };
                    }
                } else if (response.data.code === -400) {
                    return {
                        success: true,
                        apiUsed: api.name,
                        isLottery: false,
                        status: '非抽奖',
                        rawData: null,
                        retries: retryCount
                    };
                } else if (response.data.code === -9999) {
                    return {
                        success: true,
                        apiUsed: api.name,
                        isLottery: false,
                        status: '非抽奖',
                        rawData: null,
                        retries: retryCount
                    };
                } else {
                    console.log(`抽奖API返回错误: code=${response.data.code}, msg=${response.data.message}`);
                    throw new Error(`API返回错误码: ${response.data.code}`);
                }
            } catch (error) {
                console.log(`抽奖API请求失败 (重试 ${retryCount}/${maxRetries}):`, error.message);

                if (retryCount >= maxRetries) {
                    console.log(`抽奖API已达到最大重试次数 (${maxRetries})，放弃重试`);

                    let errorType = '未知错误';
                    let errorCode = 'UNKNOWN';

                    if (error.response) {
                        errorType = `HTTP ${error.response.status} 错误`;
                        errorCode = `HTTP_${error.response.status}`;
                    } else if (error.code === 'ECONNABORTED') {
                        errorType = '请求超时';
                        errorCode = 'TIMEOUT';
                    } else if (error.message.includes('Network Error')) {
                        errorType = '网络错误';
                        errorCode = 'NETWORK_ERROR';
                    } else if (error.message.includes('API返回错误码')) {
                        errorType = error.message;
                        errorCode = error.message.match(/错误码:\s*(\S+)/)?.[1] || 'API_ERROR';
                    }

                    return {
                        success: false,
                        apiUsed: api.name,
                        isLottery: null,
                        status: '查询失败',
                        rawData: null,
                        retries: retryCount,
                        error: {
                            type: errorType,
                            code: errorCode,
                            message: error.message
                        }
                    };
                }

                retryCount++;
                if (retryCount <= maxRetries) {
                    const delay = CONFIG.RETRY_DELAY * retryCount;
                    console.log(`等待 ${delay/1000} 秒后重试 (${retryCount}/${maxRetries})`);
                    await sleep(delay);
                }
            }
        }

        console.log(`抽奖API完全失败 for ${dynamicId}`);
        return {
            success: false,
            apiUsed: api.name,
            isLottery: null,
            status: '查询失败',
            rawData: null,
            retries: retryCount,
            error: {
                type: '最大重试次数耗尽',
                code: 'MAX_RETRIES_EXCEEDED',
                message: '已达到最大重试次数'
            }
        };
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
            const elapsed = Date.now() - progressData.startTime;
            timeEl.textContent = `运行时间: ${formatTime(elapsed)}`;
        }
    }

    function addProgressLog(message, type = 'info', dynamicId = null) {
        const logsContainer = document.getElementById('progress-logs');
        if (logsContainer) {
            const logItem = document.createElement('div');
            logItem.className = `log-item ${type}`;

            const now = new Date();
            const timeStr = `${now.getHours().toString().padStart(2, '0')}:${now.getMinutes().toString().padStart(2, '0')}:${now.getSeconds().toString().padStart(2, '0')}`;

            let logMessage = message;
            if (dynamicId) {
                logMessage = `[动态ID: ${dynamicId}] ${message}`;
            }

            logItem.innerHTML = `
                <span class="log-time">${timeStr}</span>
                <span class="log-message">${logMessage}</span>
            `;

            logsContainer.appendChild(logItem);
            logsContainer.scrollTop = logsContainer.scrollHeight;
        }

        progressData.logs.push({
            timestamp: new Date(),
            message: message,
            type: type,
            dynamicId: dynamicId
        });
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
        if (!progressData.endTime && progressData.startTime) {
            progressData.endTime = Date.now();
        }

        const totalTime = progressData.endTime ? progressData.endTime - progressData.startTime : 0;
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

执行时间：${new Date().toLocaleString()}
脚本版本：${GM_info.script.version}
${deletedDetailsText}

注意事项：
1. 删除的动态无法恢复，请谨慎操作
2. 建议定期清理已开奖的动态
3. 如遇问题，请检查网络连接和登录状态
`;

        console.log(report);
        addProgressLog('执行完成，详细报告已生成', 'success');

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
                        name: filename,
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
        if (isRunning) {
            sendNotification('已有任务在执行中，请等待完成');
            return;
        }

        isRunning = true;
        isPaused = false;
        initProgressData(mode);
        showProgressPanel();

        try {
            let page = 0;
            let totalProcessed = 0;

            progressData.currentStatus = '正在获取动态...';
            updateProgressDisplay();
            addProgressLog('开始获取动态数据', 'info');

            while (isRunning) {
                while (isPaused && isRunning) {
                    await sleep(CONFIG.PAUSE_CHECK_INTERVAL);
                }
                if (!isRunning) break;

                page++;
                progressData.currentPage = page;
                progressData.currentStatus = `正在处理第 ${page} 页...`;
                updateProgressDisplay();

                addProgressLog(`正在获取第 ${page} 页动态...`, 'info');

                const result = await processDynamicPage(duid, offset, mode, input, page);

                if (!result) break;

                totalProcessed += result.processedItems;
                progressData.processedItems = totalProcessed;
                offset = result.nextOffset;

                if (page % CONFIG.MEMORY_CLEANUP_INTERVAL === 0) {
                    cleanupMemory();
                }

                if (GM_getValue('auto-pause') && page % 10 === 0) {
                    togglePause();
                    addProgressLog(`已处理 ${page} 页，自动暂停。请检查后点击"继续"按钮。`, 'warning');
                    sendNotification(`已处理 ${page} 页，自动暂停`, 'warning');
                }

                if (!offset || !isRunning) {
                    if (!isRunning) {
                        progressData.currentStatus = '已停止';
                        addProgressLog('用户手动停止了处理', 'warning');
                    } else {
                        progressData.currentStatus = '处理完成';
                        addProgressLog('所有动态处理完成！', 'success');
                    }
                    updateProgressDisplay();

                    if (GM_getValue('set-unfollow') && isRunning) {
                        await sleep(2000);
                        await unfollowUser();
                    }

                    if (isRunning) {
                        progressData.endTime = Date.now();
                        generateReport();
                    }

                    break;
                }

                await sleep(CONFIG.REQUEST_DELAY);
            }
        } catch (error) {
            console.error('获取动态失败:', error);
            progressData.currentStatus = '处理出错';
            addProgressLog('处理过程中出错: ' + error.message, 'error');
            updateProgressDisplay();
            sendNotification('处理动态过程中出错: ' + error.message, 'error');
        } finally {
            isRunning = false;
        }
    }

    async function processDynamicPage(duid, offset, mode, input, pageNum) {
        const dynamics_api = `https://api.bilibili.com/x/polymer/web-dynamic/v1/feed/space?offset=${offset}&host_mid=${duid}`;

        try {
            const response = await axios({
                url: dynamics_api,
                withCredentials: true,
                timeout: 10000,
                headers: {
                    'Accept': 'application/json, text/plain, */*'
                }
            });

            if (response.data.code === 0) {
                let items_list = response.data.data.items;
                if (!items_list || items_list.length === 0) {
                    addProgressLog(`第 ${pageNum} 页没有更多动态`, 'info');
                    return null;
                }

                addProgressLog(`第 ${pageNum} 页获取到 ${items_list.length} 条动态`, 'info');

                const batches = [];
                for (let i = 0; i < items_list.length; i += CONFIG.BATCH_SIZE) {
                    batches.push(items_list.slice(i, i + CONFIG.BATCH_SIZE));
                }

                let pageProcessedItems = 0;
                let pageDeletedItems = 0;

                for (let batchIndex = 0; batchIndex < batches.length; batchIndex++) {
                    if (!isRunning) break;
                    if (isPaused) {
                        await sleep(CONFIG.PAUSE_CHECK_INTERVAL);
                        batchIndex--;
                        continue;
                    }

                    const batch = batches[batchIndex];
                    progressData.currentStatus = `处理第 ${pageNum} 页, 第 ${batchIndex + 1} 批`;
                    updateProgressDisplay();

                    const batchResult = await processDynamicBatch(batch, mode, input);
                    pageProcessedItems += batchResult.processed;
                    pageDeletedItems += batchResult.deleted;

                    if (batchIndex < batches.length - 1 && isRunning && !isPaused) {
                        await sleep(1000);
                    }
                }

                addProgressLog(`第 ${pageNum} 页完成: 处理 ${pageProcessedItems} 条, 删除 ${pageDeletedItems} 条`, 'info');

                return {
                    processedItems: pageProcessedItems,
                    nextOffset: response.data.data.offset
                };
            } else {
                if (response.data.code === -352) {
                    const key = `page_${pageNum}`;
                    retryCounts[key] = (retryCounts[key] || 0) + 1;

                    if (retryCounts[key] <= CONFIG.MAX_RETRIES) {
                        addProgressLog(`第 ${pageNum} 页遇到频率限制，${CONFIG.RETRY_DELAY/1000}秒后重试 (${retryCounts[key]}/${CONFIG.MAX_RETRIES})`, 'warning');
                        await sleep(CONFIG.RETRY_DELAY);
                        return processDynamicPage(duid, offset, mode, input, pageNum);
                    } else {
                        addProgressLog(`第 ${pageNum} 页已达到最大重试次数，跳过此页`, 'error');
                        return {
                            processedItems: 0,
                            nextOffset: response.data.data.offset || offset
                        };
                    }
                } else {
                    addProgressLog(`获取动态失败：${response.data.message} (code: ${response.data.code})`, 'error');
                    return null;
                }
            }
        } catch (error) {
            addProgressLog(`处理第 ${pageNum} 页动态失败: ${error.message}`, 'error');

            if (error.code === 'ECONNABORTED' || error.message.includes('timeout')) {
                const key = `page_${pageNum}_timeout`;
                retryCounts[key] = (retryCounts[key] || 0) + 1;

                if (retryCounts[key] <= CONFIG.MAX_RETRIES) {
                    addProgressLog(`第 ${pageNum} 页请求超时，${CONFIG.RETRY_DELAY/1000}秒后重试`, 'warning');
                    await sleep(CONFIG.RETRY_DELAY);
                    return processDynamicPage(duid, offset, mode, input, pageNum);
                }
            }

            return null;
        }
    }

    async function processDynamicBatch(batch, mode, input) {
        const promises = batch.map((data, index) =>
            processSingleDynamic(data, mode, input, index)
        );

        const results = await Promise.allSettled(promises);

        let processed = 0;
        let deleted = 0;

        results.forEach(result => {
            if (result.status === 'fulfilled') {
                processed++;
                if (result.value) deleted++;
            }
        });

        const failures = results.filter(r => r.status === 'rejected').length;

        if (processed > 0 || failures > 0) {
            addProgressLog(`批次处理完成: 处理 ${processed} 条, 删除 ${deleted} 条, 失败 ${failures} 条`,
                          failures > 0 ? 'warning' : 'success');
        }

        return {
            processed: processed,
            deleted: deleted,
            failures: failures
        };
    }

    async function processSingleDynamic(data, mode, input, index) {
        const dynamicId = data.id_str;
        console.log(`处理动态 ${index} (ID: ${dynamicId}):`, {
            id_str: dynamicId,
            type: data.type,
            has_orig: !!data.orig,
            orig_id_str: data.orig?.id_str,
            data_keys: Object.keys(data)
        });

        if (!data.orig && data.type !== 'DYNAMIC_TYPE_FORWARD') {
            addProgressLog(`不是转发动态，跳过`, 'info', dynamicId);
            return false;
        }

        try {
            if (mode === 'auto') {
                if (data.orig.id_str == null) {
                    addProgressLog(`源动态已被删除，执行删除`, 'info', dynamicId);
                    const result = await deleteDynamic(data, '源动态已被删除');
                    if (result) {
                        progressData.deletedItems++;
                        updateProgressDisplay();
                    }
                    return result;
                } else {
                    const lotteryResult = await checkLotteryStatus(data.orig.id_str, index);

                    if (lotteryResult.success) {
                        if (lotteryResult.isLottery && lotteryResult.status === 2) {
                            addProgressLog(`源动态已开奖，执行删除`, 'info', dynamicId);
                            const result = await deleteDynamic(data, `源动态已开奖`);
                            if (result) {
                                progressData.deletedItems++;
                                updateProgressDisplay();

                                if (GM_getValue('set-unfollow') && data.orig.modules.module_author.following) {
                                    saveUnfollowUser(data);
                                }
                            }
                            return result;
                        } else if (!lotteryResult.isLottery) {
                            addProgressLog(`源动态不是抽奖动态，跳过`, 'info', dynamicId);
                            return false;
                        } else {
                            const statusText = lotteryResult.status === 0 ? '未开奖' :
                                             lotteryResult.status === 1 ? '开奖中' :
                                             `状态${lotteryResult.status}`;
                            addProgressLog(`源动态${statusText}，跳过删除`, 'info', dynamicId);
                            return false;
                        }
                    } else {
                        addProgressLog(`抽奖API查询失败（重试${lotteryResult.retries || 0}次后），错误代码: ${lotteryResult.error?.code || '未知'}, 跳过删除`, 'error', dynamicId);
                        return false;
                    }
                }
            }

            if (mode === 'user') {
                const users = input.split(',').map(u => u.trim());
                const authorName = data.orig.modules.module_author.name;
                const authorId = data.orig.modules.module_author.mid.toString();

                if (users.includes(authorName) || users.includes(authorId)) {
                    addProgressLog(`匹配到指定用户 ${authorName}，执行删除`, 'info', dynamicId);
                    const result = await deleteDynamic(data, `指定用户: ${authorName}`);
                    if (result) {
                        progressData.deletedItems++;
                        updateProgressDisplay();

                        if (GM_getValue('set-unfollow') && data.orig.modules.module_author.following) {
                            saveUnfollowUser(data);
                        }
                    }
                    return result;
                }
            }

            if (mode === 'days_ago') {
                const days = parseInt(input);
                if (isNaN(days) || days <= 0) {
                    addProgressLog(`天数输入无效: ${input}`, 'error', dynamicId);
                    return false;
                }

                addProgressLog(`开始获取转发动态日期，最多重试3次...`, 'info', dynamicId);
                const forwardDateResult = await getForwardDynamicDateWithRetry(data, dynamicId, 3);

                if (!forwardDateResult.success) {
                    addProgressLog(`获取转发动态日期失败，已达到最大重试次数，跳过此动态`, 'error', dynamicId);
                    return false;
                }

                const dyn_timestamp = forwardDateResult.timestamp;
                const dyn_date = forwardDateResult.date;
                const target_date = getBeforeDate(days);

                console.log(`动态 ${dynamicId}: 转发日期=${dyn_date}, 目标日期=${target_date}, 重试次数=${forwardDateResult.retries}`);
                addProgressLog(`转发日期: ${dyn_date}, 目标日期: ${target_date} (${days}天前), 重试次数: ${forwardDateResult.retries}`, 'info', dynamicId);

                if (dyn_date && dyn_date <= target_date) {
                    addProgressLog(`满足日期条件 (${dyn_date} <= ${target_date})`, 'info', dynamicId);

                    if (data.orig.id_str) {
                        const lotteryResult = await checkLotteryStatus(data.orig.id_str, index);

                        if (lotteryResult.success) {
                            if (lotteryResult.isLottery) {
                                if (lotteryResult.status === 2) {
                                    addProgressLog(`满足日期条件且已开奖，执行删除`, 'info', dynamicId);
                                    const result = await deleteDynamic(data, `日期筛选(${days}天前)且已开奖`);
                                    if (result) {
                                        progressData.deletedItems++;
                                        updateProgressDisplay();
                                        if (GM_getValue('set-unfollow') && data.orig.modules.module_author.following) {
                                            saveUnfollowUser(data);
                                        }
                                    }
                                    return result;
                                } else {
                                    const statusText = lotteryResult.status === 0 ? '未开奖' :
                                                     lotteryResult.status === 1 ? '开奖中' :
                                                     `状态${lotteryResult.status}`;
                                    addProgressLog(`满足日期条件但${statusText}，跳过删除`, 'info', dynamicId);
                                    return false;
                                }
                            } else {
                                addProgressLog(`满足日期条件（非抽奖动态），执行删除`, 'info', dynamicId);
                                const result = await deleteDynamic(data, `日期筛选(${days}天前)的非抽奖动态`);
                                if (result) {
                                    progressData.deletedItems++;
                                    updateProgressDisplay();
                                    if (GM_getValue('set-unfollow') && data.orig.modules.module_author.following) {
                                        saveUnfollowUser(data);
                                    }
                                }
                                return result;
                            }
                        } else {
                            addProgressLog(`满足日期条件但抽奖API查询失败（重试${lotteryResult.retries || 0}次后），错误代码: ${lotteryResult.error?.code || '未知'}，跳过删除`, 'error', dynamicId);
                            return false;
                        }
                    } else {
                        addProgressLog(`满足日期条件（源动态已被删除），执行删除`, 'info', dynamicId);
                        const result = await deleteDynamic(data, `日期筛选(${days}天前)的已删除源动态`);
                        if (result) {
                            progressData.deletedItems++;
                            updateProgressDisplay();
                            if (GM_getValue('set-unfollow') && data.orig && data.orig.modules && data.orig.modules.module_author && data.orig.modules.module_author.following) {
                                saveUnfollowUser(data);
                            }
                        }
                        return result;
                    }
                }
                addProgressLog(`不满足日期条件（${dyn_date} > ${target_date}），跳过`, 'info', dynamicId);
                return false;
            }
        } catch (error) {
            addProgressLog(`处理失败: ${error.message}`, 'error', dynamicId);
            return false;
        }

        addProgressLog(`不符合任何删除条件，跳过`, 'info', dynamicId);
        return false;
    }

    async function deleteDynamic(item, reason) {
        const csrf = getCSRFToken();
        if (!csrf) {
            addProgressLog('未找到CSRF token，请重新登录。', 'error', item.id_str);
            return false;
        }

        const delete_api = `https://api.bilibili.com/x/dynamic/feed/operate/remove?platform=web&csrf=${csrf}`;
        const re_id_str = item.id_str;

        if (!re_id_str) {
            addProgressLog('动态ID为空，无法删除', 'error');
            return false;
        }

        // 动态类型判断 - 修复逻辑：使用当前动态的类型，不再使用源动态的类型
        let dyn_type = mapDynamicType(item.type);

        const requestBody = {
            dyn_id_str: re_id_str,
            dyn_type: dyn_type,
            rid_str: re_id_str
        };

        addProgressLog(`删除请求参数: 动态ID=${re_id_str}, 类型=${dyn_type} (原类型: ${item.type})`, 'info', re_id_str);

        let retries = 0;
        const maxRetries = 3;

        while (retries < maxRetries) {
            try {
                addProgressLog(`正在删除动态 (尝试 ${retries + 1}/${maxRetries})`, 'info', re_id_str);

                const response = await axios({
                    method: 'post',
                    url: delete_api,
                    withCredentials: true,
                    data: JSON.stringify(requestBody),
                    timeout: 10000,
                    headers: {
                        'Content-Type': 'application/json',
                        'Accept': 'application/json, text/plain, */*'
                    }
                });

                console.log(`删除API响应:`, {
                    code: response.data.code,
                    message: response.data.message,
                    data: response.data.data
                });

                const successCodes = [0, '0'];
                if (successCodes.includes(response.data.code)) {
                    addProgressLog(`删除成功 (API返回: ${response.data.code})`, 'success', re_id_str);
                    addDeleteRecord(item, reason);
                    return true;
                } else if (response.data.code === -403) {
                    addProgressLog('CSRF token失效，请刷新页面后重试', 'error', re_id_str);
                    break;
                } else if (response.data.code === -404) {
                    addProgressLog(`动态可能已被删除`, 'warning', re_id_str);
                    addDeleteRecord(item, `${reason} (API返回404)`);
                    return true;
                } else if (response.data.code === 4128002) {
                    addProgressLog(`操作频繁，等待后重试`, 'warning', re_id_str);
                    retries++;
                    await sleep(5000 * (retries + 1));
                    continue;
                } else {
                    addProgressLog(`删除失败: ${response.data.message || '未知错误'} (code: ${response.data.code})`, 'error', re_id_str);
                    retries++;
                    await sleep(2000 * (retries + 1));
                }
            } catch (error) {
                addProgressLog(`删除请求失败: ${error.message} (重试 ${retries + 1}/${maxRetries})`, 'error', re_id_str);
                retries++;
                await sleep(2000 * (retries + 1));
            }
        }

        addProgressLog(`动态删除失败，已达到最大重试次数`, 'error', re_id_str);
        return false;
    }

    function saveUnfollowUser(data) {
        const unfollow_arr = GM_getValue('unfollow-list');
        const uid = data.orig.modules.module_author.mid.toString();
        const name = data.orig.modules.module_author.name;

        const exists = unfollow_arr.some(item => (typeof item === 'object' ? item.uid : item) === uid);
        if (!exists) {
          unfollow_arr.push({ uid, name }); // 存储对象
          GM_setValue('unfollow-list', unfollow_arr);
          addProgressLog(`添加到取关列表: ${name} (${uid})`, 'info');
        }
    }

    async function unfollowUser() {
        const unfollow_api = 'https://api.bilibili.com/x/relation/modify';
        const unfollow_list = GM_getValue('unfollow-list');

        if (unfollow_list.length === 0) {
            addProgressLog('没有需要取关的用户。', 'info');
            return;
        }

        addProgressLog(`开始取关 ${unfollow_list.length} 个用户...`, 'info');

        let completed = 0;
        let failed = [];

        for (let i = 0; i < unfollow_list.length; i++) {
            if (!isRunning) break;
            if (isPaused) {
                await sleep(CONFIG.PAUSE_CHECK_INTERVAL);
                i--;
                continue;
            }

            const user = unfollow_list[i];
            const uid = user.uid;
            const name = user.name;

            try {
                const csrf = getCSRFToken();
                if (!csrf) {
                    addProgressLog(`未找到CSRF token，取关失败: ${name} (${uid})`, 'error');
                    progressData.unfollowFailedDetails.push({
                        uid: uid,
                        name: name,
                        timestamp: new Date().toLocaleString(),
                        reason: 'CSRF token 缺失，请重新登录'
                    });
                    failed.push({ uid, name });
                    continue;
                }

                addProgressLog(`正在取关 ${name} (${uid})...`, 'info');

                const response = await axios({
                    method: 'post',
                    url: unfollow_api,
                    withCredentials: true,
                    data: new URLSearchParams({
                        fid: uid,
                        act: '2',
                        re_src: '11',
                        spmid: '333.999.0.0',
                        csrf: csrf
                    }),
                    timeout: 10000,
                    headers: {
                        'Content-Type': 'application/x-www-form-urlencoded',
                        'Accept': 'application/json, text/plain, */*'
                    }
                });

                const successCodes = [0, '0'];
                if (successCodes.includes(response.data.code)) {
                    completed++;
                    progressData.unfollowedUsers = completed;
                    progressData.unfollowedDetails.push({
                        uid: uid,
                        name: name,
                        timestamp: new Date().toLocaleString()
                    });
                    addProgressLog(`取关成功: ${name} (${uid})`, 'success');
                    updateProgressDisplay();
                } else {
                    const errorMsg = response.data.message || '未知错误';
                    addProgressLog(`取关失败: ${errorMsg} (code: ${response.data.code}) - ${name} (${uid})`, 'error');
                    progressData.unfollowFailedDetails.push({
                        uid: uid,
                        name: name,
                        timestamp: new Date().toLocaleString(),
                        reason: `API返回错误: ${errorMsg} (code: ${response.data.code})`
                    });
                    failed.push({ uid, name });
                }
            } catch (error) {
                addProgressLog(`取关请求失败: ${error.message} - ${name} (${uid})`, 'error');
                progressData.unfollowFailedDetails.push({
                    uid: uid,
                    name: name,
                    timestamp: new Date().toLocaleString(),
                    reason: `请求异常: ${error.message}`
                });
                failed.push({ uid, name });
            }

            if (i < unfollow_list.length - 1 && isRunning && !isPaused) {
                await sleep(3000);
            }
        }

        GM_setValue('unfollow-list', []);

        let message = `取关操作完成。成功: ${completed}, 失败: ${failed.length}`;
        if (failed.length > 0) {
            message += `\n失败的用户ID: ${failed.join(', ')}`;
            addProgressLog(message, 'warning');
        } else {
            addProgressLog(message, 'success');
        }
    }

    // ========== 内存和状态管理 ==========

    function cleanupMemory() {
        if (Object.keys(retryCounts).length > 100) {
            const oldKeys = Object.keys(retryCounts).slice(0, 50);
            oldKeys.forEach(key => delete retryCounts[key]);
        }
    }

    function stopProcessing() {
        if (isRunning) {
            isRunning = false;
            isPaused = false;
            progressData.currentStatus = '已停止';
            updateProgressDisplay();
            addProgressLog('用户手动停止了处理', 'warning');
            sendNotification('处理已停止', 'warning');

            const pauseBtn = document.querySelector('.pause-btn');
            if (pauseBtn) {
                pauseBtn.innerHTML = '⏸️ 暂停';
            }
        }
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

        const duid = getUserID();

        if (!duid) {
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
            input = input.trim();
        }

        if (mode === 'days_ago') {
            input = prompt('请输入想要删除多少天前的动态 (正整数):\n例如: 30 (删除30天前的动态)\n\n注意：会尝试获取您转发该动态的日期，如果获取失败会重试3次，仍然失败则跳过该动态。抽奖API失败会重试' + getLotteryApiRetries() + '次。');
            if (!input || isNaN(parseInt(input)) || parseInt(input) <= 0) {
                sendNotification('输入错误！请输入正整数。', 'error');
                return false;
            }
        }

        // 直接构建警告信息，不再尝试获取动态总数
        let warningMsg = `抽奖API重试次数: ${getLotteryApiRetries()} 次`;

        if (mode === 'days_ago') {
            warningMsg += `\n\n日期筛选说明: 将判断您转发该动态的日期，如果获取失败会重试3次，仍然失败则跳过该动态。`;
        }

        warningMsg += '\n\n注意：这将删除符合条件的转发动态，操作不可撤销！';

        if (!confirm(`确定要开始执行"${mode}"模式吗？\n\n${warningMsg}`)) {
            return false;
        }

        console.log(`开始执行模式: ${mode}, 参数: ${input}`);

        console.log('启动任务前显示进度面板');
        showProgressPanel();

        retryCounts = {};

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
            let unfollow_list = GM_getValue('unfollow-list');
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
                                <div class="help-text">报告导出保存的文件夹名称</div>
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

        const unfollowList = GM_getValue('unfollow-list');
        unfollowCountSpan.textContent = unfollowList.length;

        const closeBtn = main_window.querySelector('.setting-close');
        const saveBtn = main_window.querySelector('.setting-save');
        const clearUnfollowBtn = document.getElementById('clear-unfollow');

        closeBtn.addEventListener('click', () => {
            closeSettingWindow();
        });

        saveBtn.addEventListener('click', () => {
            GM_setValue('set-unfollow', unfollowCheckbox.checked);
            GM_setValue('auto-pause', autoPauseCheckbox.checked);
            GM_setValue('export-path', exportPathInput.value.trim() || 'BiliDynamicCleaner');

            const retries = parseInt(lotteryApiRetriesInput.value, 10);
            if (isNaN(retries) || retries < 0 || retries > 5) {
                sendNotification('抽奖API重试次数必须为0-5之间的整数', 'error');
                return;
            }
            GM_setValue('lottery-api-retries', retries);

            sendNotification('设置已保存', 'success');
            closeSettingWindow();
        });

        clearUnfollowBtn.addEventListener('click', () => {
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
