/**
 * Reused from the supplied allocator_real.mjs and independently checked against
 * the unchanged Python allocator, frozen T1 cases and random sequence oracles.
 */
export class ThresholdAllocator {
  constructor(capacity, scale = 1) {
    if (!Number.isFinite(capacity) || capacity <= 0 || !Number.isFinite(scale) || scale <= 0) {
      throw new RangeError('容量与阈值倍数必须为有限正数');
    }
    this.capacity = capacity;
    this.agcFloor = capacity * 0.02;
    this.follow = capacity * 0.01 * scale;
    this.dispatchExit = capacity * 0.005 * scale;
    this.predEnter = capacity * 0.02 * scale;
    this.predExit = capacity * 0.01 * scale;
    this.reset();
  }

  reset() {
    this.dispatch = false;
    this.prediction = false;
  }

  calculate(a, f, g, p) {
    for (const v of [a, f, g, p]) {
      if (!Number.isFinite(v) || v < 0) throw new RangeError('有效分钟须使用有限非负功率');
    }
    const diff = f - g;
    this.dispatch = this.dispatch ? diff > this.dispatchExit : diff > this.follow;
    const trackingReference = Math.max(f, this.agcFloor);
    const following = !this.dispatch && Math.abs(g - trackingReference) <= this.follow;
    const floorFollowing = following && f < this.agcFloor;
    const headroom = a - Math.max(f, g);
    this.prediction = this.prediction ? headroom > this.predExit : headroom > this.predEnter;
    if (!(following || this.dispatch)) this.prediction = false;

    const bottom = Math.max(g, p);
    const opportunity = Math.max(a - bottom, 0);
    const dispatch = this.dispatch ? Math.max(Math.min(a, f) - bottom, 0) : 0;
    const prediction = this.prediction
      ? (this.dispatch ? Math.max(a - Math.max(f, g, p), 0) : opportunity)
      : 0;
    const remaining = Math.max(opportunity - dispatch - prediction, 0);
    const unexplained = !(following || this.dispatch) ? remaining : 0;
    const noiseAbove = remaining - unexplained;
    const below = Math.max(Math.min(a, g) - p, 0);
    const operational = below > this.dispatchExit ? below : 0;
    const noiseBelow = below - operational;
    const other = remaining + below;

    let note = this.dispatch ? '调度压低状态'
      : floorFollowing ? 'AGC 受2%容量下限约束的预测跟随'
      : following ? 'AGC 跟随预测'
      : 'AGC 明显高于预测且不符合下限跟随，原因待核实';
    if (this.prediction) note += '；预测低估空间已达到阈值';
    if (operational) note += '；另有场站指令以下未发差额';
    if (noiseAbove + noiseBelow) note += '；小偏差单列，不计入两类限电';

    const values = {
      dispatch, prediction, other, above: remaining, below, gap: Math.max(a - p, 0),
      noiseAbove, noiseBelow, operationalBelow: operational, unexplainedAbove: unexplained,
      referenceTotal: Math.max(a - g, 0), releasedAboveAgc: Math.max(Math.min(a, p) - g, 0),
    };

    // Python math.isclose defaults to rel_tol=1e-9, in addition to abs_tol=1e-8.
    const close=(a,b)=>Math.abs(a-b)<=Math.max(1e-8,1e-9*Math.max(Math.abs(a),Math.abs(b)));
    const gapClosure = dispatch + prediction + other;
    if (!close(values.gap,gapClosure)) {
      throw new Error(`gap 闭合校验失败: ${values.gap} vs ${gapClosure}`);
    }
    const refClosure = dispatch + prediction + remaining + values.releasedAboveAgc;
    if (!close(values.referenceTotal,refClosure)) {
      throw new Error(`referenceTotal 闭合校验失败: ${values.referenceTotal} vs ${refClosure}`);
    }

    const perMinute = {};
    for (const [k, v] of Object.entries(values)) perMinute[k] = v / 60;

    const bandDefs = [
      ['other', p, Math.min(a, g)],
      ['dispatch', bottom, bottom + dispatch],
      ['other', bottom + dispatch, a - prediction],
      ['prediction', a - prediction, a],
    ];
    const allocationBands = bandDefs
      .filter(([kind, lo, hi]) => hi > lo
        && (kind !== 'dispatch' || dispatch > 0)
        && (kind !== 'prediction' || prediction > 0))
      .map(([kind, lo, hi]) => ({ kind, bottom: lo, top: hi }));

    return {
      ...perMinute,
      dispatchState: this.dispatch, predictionState: this.prediction,
      following, floorFollowing, trackingReference, note, allocationBands,
    };
  }
}
