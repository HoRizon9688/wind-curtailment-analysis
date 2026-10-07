"""Capacity-relative hysteresis with causal three-minute dispatch confirmation."""
import math


class ThresholdAllocator:
    def __init__(self, capacity, scale=1):
        if not math.isfinite(capacity) or capacity<=0 or not math.isfinite(scale) or scale<=0:
            raise ValueError('容量与阈值倍数必须为有限正数')
        self.capacity=capacity
        self.agc_floor=capacity*.02
        self.follow=capacity*.01*scale
        self.dispatch_exit=capacity*.005*scale
        self.pred_enter=capacity*.02*scale
        self.pred_exit=capacity*.01*scale
        self.dispatch_confirm_minutes=3
        self.reset()

    def reset(self):
        self.dispatch=False
        self.prediction=False
        self.dispatch_enter_count=0
        self.dispatch_exit_count=0

    def calculate(self,a,f,g,p):
        if any(not math.isfinite(v) or v<0 for v in (a,f,g,p)):
            raise ValueError('有效分钟须使用有限非负功率')
        # Confirm on the third consecutive valid minute; never backfill earlier rows.
        # The chronological caller resets on excluded minutes, but not at midnight.
        diff=f-g
        if self.dispatch:
            self.dispatch_enter_count=0
            self.dispatch_exit_count=self.dispatch_exit_count+1 if diff<=self.dispatch_exit else 0
            if self.dispatch_exit_count>=self.dispatch_confirm_minutes:
                self.dispatch=False
                self.dispatch_exit_count=0
        else:
            self.dispatch_exit_count=0
            self.dispatch_enter_count=self.dispatch_enter_count+1 if diff>self.follow else 0
            if self.dispatch_enter_count>=self.dispatch_confirm_minutes:
                self.dispatch=True
                self.dispatch_enter_count=0
        tracking_reference=max(f,self.agc_floor)
        following=not self.dispatch and abs(g-tracking_reference)<=self.follow
        floor_following=following and f<self.agc_floor
        # Retaining historical dispatch state during exit confirmation does not
        # explain a new AGC that is clearly above the forecast/floor reference.
        explained=following or (self.dispatch and g-tracking_reference<=self.follow)
        headroom=a-max(f,g)
        self.prediction=headroom>self.pred_exit if self.prediction else headroom>self.pred_enter
        if not explained:
            self.prediction=False
        bottom=max(g,p)
        opportunity=max(a-bottom,0)
        dispatch=max(min(a,f)-bottom,0) if self.dispatch else 0
        prediction=(max(a-max(f,g,p),0) if self.dispatch else opportunity) if self.prediction else 0
        remaining=max(opportunity-dispatch-prediction,0)
        unexplained=remaining if not explained else 0
        noise_above=remaining-unexplained
        below=max(min(a,g)-p,0)
        operational=below if below>self.dispatch_exit else 0
        noise_below=below-operational
        other=remaining+below
        note=('调度压低状态' if self.dispatch else 'AGC 受2%容量下限约束的预测跟随' if floor_following else 'AGC 跟随预测' if following else 'AGC 明显高于预测且不符合下限跟随，原因待核实')
        if self.dispatch_enter_count:
            note=f'调度进入待确认（{self.dispatch_enter_count}/3分钟）；指令以上差额暂列待核实，不回填'
        elif self.dispatch_exit_count:
            note+=f'；调度退出待确认（{self.dispatch_exit_count}/3分钟）'
            if not explained:
                note+='；AGC 明显高于预测且不符合下限跟随，原因待核实'
        if self.prediction:note+='；预测低估空间已达到阈值'
        if operational:note+='；另有场站指令以下未发差额'
        if noise_above+noise_below:note+='；小偏差单列，不计入两类限电'
        values={'dispatch':dispatch,'prediction':prediction,'other':other,'above':remaining,'below':below,
                'gap':max(a-p,0),'noiseAbove':noise_above,'noiseBelow':noise_below,
                'operationalBelow':operational,'unexplainedAbove':unexplained,
                'referenceTotal':max(a-g,0),'releasedAboveAgc':max(min(a,p)-g,0)}
        # Actual-output closure and independent command-space closure.
        assert math.isclose(values['gap'],dispatch+prediction+other,abs_tol=1e-8)
        assert math.isclose(values['referenceTotal'],dispatch+prediction+remaining+values['releasedAboveAgc'],abs_tol=1e-8)
        return {**{k:v/60 for k,v in values.items()},'dispatchState':self.dispatch,
                'predictionState':self.prediction,'following':following,'floorFollowing':floor_following,
                'trackingReference':tracking_reference,'note':note,
                'allocationBands':[
                    {'kind':kind,'bottom':lo,'top':hi}
                    for kind,lo,hi in [('other',p,min(a,g)),('dispatch',bottom,bottom+dispatch),
                                      ('other',bottom+dispatch,a-prediction),('prediction',a-prediction,a)]
                    if hi>lo and (kind!='dispatch' or dispatch>0) and (kind!='prediction' or prediction>0)]}
