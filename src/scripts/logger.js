define([], function () {
    // Minimal console-based logger with manual gating

    var enabled = {
        error: true,
        warning: true,
        info: true,
        debug: false,
        timestamp: false,
    };

    /**
     * Logs a message to the console for the given type if enabled.
     * @param {'error'|'warning'|'info'|'debug'|'timestamp'} type - Log type/category.
     * @param {string} message - Message text to emit.
     * @param {object} [ctx] - Optional context object serialized inline.
     * @returns {void}
     */
    function logToConsole(type, message, ctx) {
        if (!enabled[type]) return;
        var prefix = 'Create Child Tasks';
        var ctxStr = ctx ? ' ' + JSON.stringify(ctx) : '';
        var method = console.log;
        if (type === 'error') method = console.error;
        else if (type === 'warning') method = console.warn;
        else if (type === 'info') method = console.info;
        method(prefix + ' [' + type + ']: ' + (message || '') + ctxStr);
    }

    /**
     * Sets logger mode to control which log types are enabled.
     * - 'dev' enables all types; 'release' enables error/warning/info.
     * @param {'dev'|'release'} mode - Runtime mode.
     * @returns {void}
     */
    function setMode(mode) {
        // Simple mapping: dev => all; release => error/warning/info
        var all = ['error', 'warning', 'info', 'debug', 'timestamp'];
        var types = ['error', 'warning', 'info'];
        if (mode === 'dev') {
            types = all;
        }
        enabled.error = false;
        enabled.warning = false;
        enabled.info = false;
        enabled.debug = false;
        enabled.timestamp = false;
        for (var i = 0; i < types.length; i++) {
            enabled[types[i]] = true;
        }
    }

    var api = {
        /**
         * Initialize the logger with an explicit mode; defaults to 'release'.
         * @param {'dev'|'release'} [explicitMode] - Desired logging mode.
         * @returns {void}
         */
        init: function (explicitMode) {
            // Single call: pick explicit mode or default to release
            setMode(explicitMode || 'release');
        },

        /**
         * Emit an error-level log.
         * @param {string} msg - Message text.
         * @param {object} [ctx] - Optional context.
         * @returns {void}
         */
        error: function (msg, ctx) { logToConsole('error', msg, ctx); },

        /**
         * Emit a warning-level log.
         * @param {string} msg - Message text.
         * @param {object} [ctx] - Optional context.
         * @returns {void}
         */
        warn: function (msg, ctx) { logToConsole('warning', msg, ctx); },

        /**
         * Emit an info-level log.
         * @param {string} msg - Message text.
         * @param {object} [ctx] - Optional context.
         * @returns {void}
         */
        info: function (msg, ctx) { logToConsole('info', msg, ctx); },
        
        /**
         * Emit a debug-level log.
         * @param {string} msg - Message text.
         * @param {object} [ctx] - Optional context.
         * @returns {void}
         */
        debug: function (msg, ctx) { logToConsole('debug', msg, ctx); }
    };

    // Timestamp helpers: init marker and since-init checkpoints
    var perfInitTs = null;

    /**
     * Low-level timestamp log with explicit duration.
     * @param {string} label - Human-friendly event label.
     * @param {number} durationMs - Duration in milliseconds.
     * @param {object} [ctx] - Additional context fields.
     * @returns {void}
     */
    function timestampLog(label, durationMs, ctx) {
        logToConsole('timestamp', label + ' ' + durationMs + ' ms', ctx);
    }

    /**
     * Set the init timestamp used as baseline for subsequent events.
     * @param {number} ts - Milliseconds since epoch.
     * @returns {void}
     */
    function timestampSetInit(ts) { perfInitTs = ts; }

    /**
     * Log a timestamped event with automatic duration calculation.
     * If `startTsOptional` is provided, duration = now - start; else uses since-init.
     * @param {string} label - Event label.
     * @param {number} [startTsOptional] - Optional phase start timestamp (ms since epoch).
     * @param {object} [extraCtx] - Optional context fields to merge.
     * @returns {void}
     */
    function timestamp(label, startTsOptional, extraCtx) {
        var now = Date.now();
        var sinceInit = perfInitTs ? (now - perfInitTs) : 0;
        var durationMs = (typeof startTsOptional === 'number') ? (now - startTsOptional) : sinceInit;
        var ctx = { sinceInitMs: sinceInit };
        if (extraCtx && typeof extraCtx === 'object') {
            try {
                for (var k in extraCtx) { if (extraCtx.hasOwnProperty(k)) { ctx[k] = extraCtx[k]; } }
            } catch (e) { /* ignore merge errors */ }
        }
        timestampLog(label, durationMs, ctx);
    }

    api.timestamp = timestamp;
    api.timestamp.log = timestampLog;
    api.timestamp.setInit = timestampSetInit;

    // Back-compat aliases with methods
    /**
     * @deprecated Use `timestamp` instead.
     */
    api.perf = api.timestamp;

    /**
     * @deprecated Use `timestamp` instead.
     */
    api.performance = api.timestamp;
    api.perf.log = api.timestamp.log;
    api.perf.setInit = api.timestamp.setInit;
    api.performance.log = api.timestamp.log;
    api.performance.setInit = api.timestamp.setInit;

    try { api.init(); } catch (e) { /* ignore */ }

    return api;
});
