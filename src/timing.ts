/**
 * 亚毫秒耗时的测量器。
 *
 * ## 为什么不能直接 `t0 = now(); work(); now() - t0`
 * Chromium 的 `performance.now()` 只有 **0.1ms** 精度（跨源隔离的页面才有 5µs），
 * 而本 Demo 的可见性求解只要 ~0.012ms —— 比一个时钟刻度还小一个数量级，
 * 单次测量只会得到 0 或 0.1ms，HUD 上就变成「不是 1µs 就是 1.00ms」。
 *
 * ## 做法
 * 连着跑 K 次再除以 K，把总耗时抬到刻度之上。关键是 K 怎么取：
 *
 * - K 由「一批希望跑多久」反推：`K = targetMs / 单次估计`。
 *   于是**一批的总时长恒定在 targetMs**，量化误差 = 时钟刻度 / targetMs ≈ 7%，与单次快慢无关。
 * - 这里**不能**改成「K 太大就调小」那种自适应：那会形成正反馈 ——
 *   估计值偏高 ⇒ K 变小 ⇒ 量化误差变大 ⇒ 估计值更高，最后锁死在 K=8、读数虚高五倍。
 * - 单次采样还会被 GC / 合成器 / 缓存污染随机拖慢（帧内实测能差 2~4 倍），
 *   所以取最近若干次的**最小值** —— 我们要回答的是「这段计算本身多快」，
 *   而不是「这一帧有多吵」；最小值正是干扰最少的那次。
 * - 采样之间隔若干帧，把这一批的开销摊薄（默认每帧 0.025ms 预算 ⇒ 约每 60 帧采一次，
 *   实测摊到每帧 ~0.03ms，占 60fps 帧时间的 0.2%；峰值只是每 60 帧里有一帧多花 1.5ms）。
 *   app 里还会在「暂停 / 页面不可见 / 面板已隐藏」时直接跳过采样 —— 没人看就不测。
 *
 * 批量跑用的输入完全相同，所以不会改变这一帧的可见性结果。
 */
export class CostMeter {
  /** 对外给出的估计值（ms） */
  private estimate: number;
  /** 还要等几帧才采样 */
  private countdown = 0;
  /** 最近的若干次测量，取最小值 */
  private readonly recent: number[] = [];
  /** 最近一次批量的原始数据（调试用） */
  readonly lastBatch = { k: 0, elapsed: 0, samples: 0 };

  constructor(
    private readonly run: () => void,
    /** 一批希望跑多久（ms）：越大越准，代价是要摊到后续帧里 */
    private readonly targetMs = 1.5,
    /** 期望摊到每帧的采样开销（ms）：越小越省，但读数更新越慢 */
    private readonly budgetPerFrame = 0.025,
    /** 窗口长度（取中位数） */
    private readonly windowSize = 7,
    /** 单次调用的初始估计（ms），只影响第一次的 K */
    initial = 0.03,
    /** K 的上限，防止极快的调用把一批拉得过长 */
    private readonly maxK = 512,
  ) {
    this.estimate = initial;
  }

  /** 下次调用立刻重新采样（切换算法、改射线数之后要调）。 */
  invalidate(): void {
    this.countdown = 0;
    this.recent.length = 0;
  }

  /** 是否已经真正测过一次（没测过时 value 返回 NaN，HUD 显示「—」而不是初始猜测值）。 */
  get measured(): boolean {
    return this.recent.length > 0;
  }

  /** 当前估计耗时（ms）；还没测过则是 NaN。 */
  get value(): number {
    return this.measured ? this.estimate : NaN;
  }

  /** 返回当前估计；到点时会真的跑一批并更新估计。 */
  sample(): number {
    if (this.countdown > 0) {
      this.countdown--;
      return this.estimate;
    }

    const perCall = Math.max(this.estimate, 1e-4);
    const k = Math.max(1, Math.min(Math.round(this.targetMs / perCall), this.maxK));

    this.run(); // 预热一次，避免把 JIT / 缓存首次效应算进去
    const t0 = performance.now();
    for (let i = 0; i < k; i++) this.run();
    const elapsed = performance.now() - t0;

    this.lastBatch.k = k;
    this.lastBatch.elapsed = elapsed;
    this.lastBatch.samples = this.recent.length;

    // elapsed 为 0 说明连 K 次都没跨过一个时钟刻度，此时保留旧估计
    if (elapsed > 0) {
      this.recent.push(elapsed / k);
      if (this.recent.length > this.windowSize) this.recent.shift();
      this.estimate = Math.min(...this.recent);
    }

    // 把这一批的开销摊到接下来若干帧里
    this.countdown = Math.min(600, Math.max(12, Math.ceil((k * this.estimate) / this.budgetPerFrame)));
    return this.estimate;
  }
}
