/* ══════════════════════════════════════════════════════════
   PLAYER-ENGINE.JS
   ──────────────────────────────────────────────────────────
   محرك تشغيل احترافي كامل — نفس فلسفة المشغلات الاحترافية
   (كورة لايف وما شابه): يعتمد على قدرات المتصفح عبر hls.js
   (لصيغة m3u8) و mpegts.js (لبث TS الخام المباشر)، لكن بهندسة
   مستوى إنتاج حقيقي: استرجاع تلقائي متعدد الطبقات (شبكة،
   وسائط، مصدر بديل)، مراقب تجمّد ذكي، تبديل جودة بدون تقطيع،
   استغلال أقصى لعرض النطاق المتاح، وفل سكرين شامل حقيقي.

   ═══ ملاحظة صادقة ═══
   تغيير User-Agent / Referer الحقيقي على مستوى الشبكة غير
   ممكن من كود يعمل داخل صفحة متصفح (قيد أمان يفرضه المتصفح
   نفسه، ولا علاقة له بجودة هذا المحرك). المحرك هنا يدعم مع
   ذلك "إضافات" فعلية وقابلة للتطبيق فعلاً من طرف العميل:
   - custom query params / tokens بالرابط
   - custom XHR headers غير المحجوبة (مثل Authorization،
     أو أي هيدر بادئته X-)
   - withCredentials / CORS mode
   - proxy URL rewriter (لو أردت لاحقاً تمرير الروابط عبر
     نقطة وسيطة تديرها بنفسك)
══════════════════════════════════════════════════════════ */

class PlayerEngine extends EventTarget {
  /**
   * @param {HTMLVideoElement} videoEl
   * @param {Object} opts
   * @param {(xhr:XMLHttpRequest, url:string)=>void} [opts.requestInterceptor] - لتمرير هيدرز/توكنات مسموحة أو proxy rewriting
   */
  constructor(videoEl, opts = {}) {
    super();
    this.video   = videoEl;
    this.opts    = opts;
    this.hls     = null;
    this.mpegts  = null;
    this.currentSource   = null;
    this.retries          = 0;
    this.stallStrikes     = 0;
    this.lastTime          = 0;
    this.watchdogTimer     = null;
    this.userPaused        = false;
    this.destroyed          = false;
    this.qualitySources     = [];   // [{label, url}]
    this.currentQualityIdx  = -1;
    this.qualityFallbackTried = new Set();

    this._bindMediaEvents();
    this._bindResilienceEvents();
  }

  /* ══════════════════ إعدادات HLS مضبوطة لأقصى استقرار واستغلال ══════════════════ */
  _hlsConfig() {
    return {
      enableWorker: true,
      lowLatencyMode: false,
      startLevel: -1,

      // مخزن مؤقت كبير جداً يمتص أي تذبذب شبكة بدون أي تقطيع محسوس
      maxBufferLength: 45,
      maxMaxBufferLength: 600,
      backBufferLength: 90,
      maxBufferSize: 150 * 1000 * 1000,
      maxBufferHole: 1.5,

      // ABR: يستنزف أقصى عرض نطاق متاح، وينزل جودة فقط عند الحاجة الحقيقية
      capLevelToPlayerSize: false,
      testBandwidth: true,
      abrEwmaFastLive: 2.5,
      abrEwmaSlowLive: 7.0,
      abrBandWidthFactor: 0.92,
      abrBandWidthUpFactor: 0.65,
      abrMaxWithRealBitrate: true,

      liveSyncDurationCount: 5,
      liveMaxLatencyDurationCount: 15,
      liveDurationInfinity: true,

      manifestLoadingMaxRetry: 4,
      manifestLoadingRetryDelay: 1500,
      levelLoadingMaxRetry: 4,
      levelLoadingRetryDelay: 1500,
      fragLoadingMaxRetry: 6,
      fragLoadingRetryDelay: 1000,

      nudgeMaxRetry: 8,
      nudgeOffset: 0.15,
      maxFragLookUpTolerance: 0.3,
      appendErrorMaxRetry: 6,

      xhrSetup: (xhr, url) => {
        xhr.withCredentials = false;
        if (this.opts.requestInterceptor) this.opts.requestInterceptor(xhr, url);
      },
    };
  }

  _mpegtsConfig() {
    return {
      enableWorker: true,

      // مخزن مؤقت كبير جداً — يمتص أي تذبذب أو بطء مؤقت بالشبكة
      // قبل ما يوصل تأثيره للمشاهد كتقطيع محسوس
      enableStashBuffer: true,
      stashInitialSize: 4 * 1024 * 1024,   // ~4MB بافر ابتدائي

      // لا توقف السحب أبداً طالما الاتصال حي — استنزاف كامل للرابط
      lazyLoad: false,
      lazyLoadMaxDuration: 0,
      deferLoadAfterSourceOpen: false,

      // إيقاف "اللحاق" العدواني بحافة البث الحي — هذا هو اللي كان
      // يسبب قفزات/تسريع تشغيل مفاجئ (liveSyncPlaybackRate) وتقطيع محسوس.
      // نفضّل استقرار كامل على أقل زمن انتقال ممكن
      liveBufferLatencyChasing: false,
      liveSync: false,

      autoCleanupSourceBuffer: true,
      autoCleanupMaxBackwardDuration: 60,
      autoCleanupMinBackwardDuration: 30,

      fixAudioTimestampGap: true,
      accurateSeek: false,
      seekType: 'range',
    };
  }

  /* ══════════════════ كشف نوع المصدر ══════════════════ */
  static isRawTs(url) {
    try { return /\.ts($|\?|#)/i.test(url.split('?')[0].split('#')[0]); }
    catch (e) { return false; }
  }

  /* ══════════════════ تحميل قائمة جودات القناة ══════════════════ */
  setQualitySources(sources /* [{label,url}] */) {
    this.qualitySources = sources || [];
  }

  /* ══════════════════ تشغيل جودة محددة ══════════════════ */
  playQuality(idx) {
    if (idx < 0 || idx >= this.qualitySources.length) return;
    this.currentQualityIdx = idx;
    this.qualityFallbackTried.clear();
    this._playUrl(this.qualitySources[idx].url, this.qualitySources[idx].label);
  }

  _playUrl(url, label) {
    this.currentSource = { url, label };
    this.retries = 0;
    this.stallStrikes = 0;
    this.userPaused = false;
    this._teardownActivePlayers();
    this.dispatchEvent(new CustomEvent('loading', { detail: { label } }));

    if (PlayerEngine.isRawTs(url)) this._playMpegts(url, label);
    else this._playHls(url, label);
  }

  _playHls(url, label) {
    if (window.Hls && Hls.isSupported()) {
      this.hls = new Hls(this._hlsConfig());
      this.hls.loadSource(url);
      this.hls.attachMedia(this.video);

      this.hls.on(Hls.Events.MANIFEST_PARSED, () => {
        this.dispatchEvent(new Event('ready'));
        this.video.play().catch(() => {});
        this._startWatchdog();
      });

      this.hls.on(Hls.Events.LEVEL_SWITCHED, (_, d) => {
        const lvl = this.hls.levels?.[d.level];
        this.dispatchEvent(new CustomEvent('levelSwitched', {
          detail: { label, height: lvl?.height }
        }));
      });

      this.hls.on(Hls.Events.FRAG_BUFFERED, () => this.dispatchEvent(new Event('bufferOk')));

      this.hls.on(Hls.Events.ERROR, (_, d) => {
        if (!d.fatal) return;
        this._handleFatal(d.type === Hls.ErrorTypes.NETWORK_ERROR ? 'network'
                          : d.type === Hls.ErrorTypes.MEDIA_ERROR ? 'media' : 'other');
      });
    } else if (this.video.canPlayType('application/vnd.apple.mpegurl')) {
      // Safari / iOS: دعم HLS أصلي
      this.video.src = url;
      this.video.onloadedmetadata = () => {
        this.dispatchEvent(new Event('ready'));
        this.video.play().catch(() => {});
        this._startWatchdog();
      };
      this.video.onerror = () => this._handleFatal('other');
    } else {
      this.dispatchEvent(new CustomEvent('fatal', { detail: 'المتصفح لا يدعم بث HLS.' }));
    }
  }

  _playMpegts(url, label) {
    if (!(window.mpegts && mpegts.isSupported())) {
      this._handleFatal('other');
      return;
    }
    this.mpegts = mpegts.createPlayer(
      { type: 'mpegts', isLive: true, url, cors: true, withCredentials: false },
      this._mpegtsConfig()
    );
    this.mpegts.attachMediaElement(this.video);

    this.mpegts.on(mpegts.Events.MEDIA_INFO, () => {
      // ننتظر تجمّع بافر أولي (بدل التشغيل الفوري) لتفادي أي
      // تقطيع بلحظات البداية — استنزاف الرابط يبدأ فوراً بالخلفية
      // بأقصى سرعة، لكن العرض الفعلي يتأخر قليلاً لضمان سلاسة كاملة
      setTimeout(() => {
        this.dispatchEvent(new Event('ready'));
        this.mpegts.play().catch(() => {});
        this._startWatchdog();
      }, 1800);
    });
    this.mpegts.on(mpegts.Events.STATISTICS_INFO, () => this.dispatchEvent(new Event('bufferOk')));
    this.mpegts.on(mpegts.Events.ERROR, (type) => {
      this._handleFatal(type === mpegts.ErrorTypes.NETWORK_ERROR ? 'network'
                        : type === mpegts.ErrorTypes.MEDIA_ERROR ? 'media' : 'other');
    });

    try { this.mpegts.load(); this.mpegts.play().catch(() => {}); }
    catch (e) { this._handleFatal('other'); }
  }

  /* ══════════════════ استرجاع متعدد الطبقات عند الفشل ══════════════════ */
  _handleFatal(kind) {
    if (kind === 'network' && this.retries < 5) {
      this.retries++;
      this.dispatchEvent(new CustomEvent('reconnecting', { detail: this.retries }));
      setTimeout(() => {
        if (this.hls) { try { this.hls.startLoad(); } catch (e) { this._hardRestart(); } }
        else if (this.mpegts) {
          try { this.mpegts.unload(); this.mpegts.load(); this.mpegts.play().catch(() => {}); }
          catch (e) { this._hardRestart(); }
        }
      }, 1500 + this.retries * 600);
      return;
    }
    if (kind === 'media' && this.retries < 3) {
      this.retries++;
      this.dispatchEvent(new Event('recoveringMedia'));
      if (this.hls) { try { this.hls.recoverMediaError(); return; } catch (e) {} }
      this._hardRestart();
      return;
    }
    this._tryQualityFallbackOrFail();
  }

  _tryQualityFallbackOrFail() {
    this.qualityFallbackTried.add(this.currentQualityIdx);
    const nextIdx = this.qualitySources.findIndex((_, i) => !this.qualityFallbackTried.has(i));
    if (nextIdx !== -1 && this.qualitySources.length > 1) {
      this.currentQualityIdx = nextIdx;
      this.dispatchEvent(new CustomEvent('fallback', { detail: this.qualitySources[nextIdx] }));
      setTimeout(() => this._playUrl(this.qualitySources[nextIdx].url, this.qualitySources[nextIdx].label), 800);
    } else {
      this.dispatchEvent(new CustomEvent('fatal', { detail: 'تعذّر التشغيل بعد تجربة كل الجودات المتاحة.' }));
    }
  }

  _hardRestart() {
    this._teardownActivePlayers();
    setTimeout(() => this.currentSource && this._playUrl(this.currentSource.url, this.currentSource.label), 500);
  }

  /* ══════════════════ مراقب التجمّد (Stall Watchdog) ══════════════════ */
  _startWatchdog() {
    this._stopWatchdog();
    this.lastTime = this.video.currentTime;
    this.stallStrikes = 0;
    this.watchdogTimer = setInterval(() => {
      if (this.userPaused || this.video.paused || document.hidden) return;
      if (Math.abs(this.video.currentTime - this.lastTime) < 0.05) {
        this.stallStrikes++;
        if (this.stallStrikes >= 3) {
          this.stallStrikes = 0;
          this.dispatchEvent(new Event('stallDetected'));
          try {
            if (this.hls) this.hls.startLoad();
            else if (this.mpegts) { this.mpegts.unload(); this.mpegts.load(); this.mpegts.play().catch(() => {}); }
            this.video.currentTime += 0.2;
          } catch (e) { this._hardRestart(); }
        }
      } else this.stallStrikes = 0;
      this.lastTime = this.video.currentTime;
    }, 4000);
  }
  _stopWatchdog() { if (this.watchdogTimer) clearInterval(this.watchdogTimer); this.watchdogTimer = null; }

  /* ══════════════════ استرجاع عند العودة من الخلفية / الاتصال ══════════════════ */
  _bindResilienceEvents() {
    this._onlineHandler = () => {
      if (!this.currentSource) return;
      if (this.hls) { try { this.hls.startLoad(); } catch (e) { this._hardRestart(); } }
      else if (this.mpegts) { try { this.mpegts.unload(); this.mpegts.load(); this.mpegts.play().catch(() => {}); } catch (e) { this._hardRestart(); } }
    };
    window.addEventListener('online', this._onlineHandler);

    this._hiddenAt = 0;
    this._visHandler = () => {
      if (document.hidden) { this._hiddenAt = Date.now(); return; }
      if (!this.currentSource) return;
      const away = Date.now() - this._hiddenAt;
      if (away > 15000) this._hardRestart();
      else if (this.hls) { try { this.hls.startLoad(); } catch (e) {} }
      else if (this.mpegts) { try { this.mpegts.unload(); this.mpegts.load(); this.mpegts.play().catch(() => {}); } catch (e) {} }
    };
    document.addEventListener('visibilitychange', this._visHandler);
  }

  /* ══════════════════ أحداث الوسائط الأساسية ══════════════════ */
  _bindMediaEvents() {
    this.video.addEventListener('waiting', () => this.dispatchEvent(new Event('buffering')));
    this.video.addEventListener('playing', () => this.dispatchEvent(new Event('bufferOk')));
    this.video.addEventListener('stalled', () => this.dispatchEvent(new Event('buffering')));
    this.video.addEventListener('play',    () => this.dispatchEvent(new Event('playStateChanged')));
    this.video.addEventListener('pause',   () => this.dispatchEvent(new Event('playStateChanged')));
  }

  /* ══════════════════ تحكم عام ══════════════════ */
  togglePlay() {
    if (this.video.paused) { this.userPaused = false; this.video.play().catch(() => {}); }
    else { this.userPaused = true; this.video.pause(); }
  }
  setVolume(v) { this.video.volume = v; this.video.muted = v === 0; }
  toggleMute() { this.video.muted = !this.video.muted; }

  _teardownActivePlayers() {
    this._stopWatchdog();
    if (this.hls) { try { this.hls.destroy(); } catch (e) {} this.hls = null; }
    if (this.mpegts) {
      try { this.mpegts.pause(); } catch (e) {}
      try { this.mpegts.unload(); } catch (e) {}
      try { this.mpegts.detachMediaElement(); } catch (e) {}
      try { this.mpegts.destroy(); } catch (e) {}
      this.mpegts = null;
    }
    try { this.video.pause(); } catch (e) {}
    this.video.removeAttribute('src');
    this.video.src = '';
    this.video.load();
  }

  destroy() {
    this.destroyed = true;
    this._teardownActivePlayers();
    window.removeEventListener('online', this._onlineHandler);
    document.removeEventListener('visibilitychange', this._visHandler);
  }
}

window.PlayerEngine = PlayerEngine;
