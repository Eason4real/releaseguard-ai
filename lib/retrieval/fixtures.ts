export const INCIDENT_CORPUS_VERSION = "phase3-incidents-v1";

export type IncidentFixture = {
  incidentId: string;
  title: string;
  platform: string;
  versions: string[];
  metricKeys: string[];
  regions: string[];
  userTypes: string[];
  components: string[];
  severity: string;
  sections: Record<string, string>;
};

export const incidentFixtures: IncidentFixture[] = [
  {
    incidentId: "INC-2024-081",
    title: "Android 优惠券立即重试与幂等锁冲突",
    platform: "Android",
    versions: ["6.8.2"],
    metricKeys: ["coupon_claim_success_rate"],
    regions: ["AU", "US"],
    userTypes: ["NEW", "RETURNING"],
    components: ["CouponClaimService", "IdempotencyGuard"],
    severity: "HIGH",
    sections: {
      symptoms: "版本发布后优惠券领取按钮持续转圈，重复点击后仍然超时。领取成功率在十五分钟内显著下降。",
      root_cause: "客户端触发服务端立即重试，新请求在旧幂等锁仍有效时到达，服务返回处理中并最终超时。",
      resolution: "回滚立即重试策略，延长幂等记录生命周期并在客户端加入指数退避。",
    },
  },
  {
    incidentId: "INC-2025-014",
    title: "支付网关抖动导致优惠券支付转化下降",
    platform: "Android",
    versions: ["7.1.0"],
    metricKeys: ["coupon_claim_success_rate", "payment_success_rate"],
    regions: ["US"],
    userTypes: ["NEW", "RETURNING"],
    components: ["PaymentGateway"],
    severity: "HIGH",
    sections: {
      symptoms: "优惠券领取失败与支付失败同时上升，Android 多个版本均受影响。",
      root_cause: "第三方支付网关发生区域性抖动，与客户端版本和幂等锁无关。",
      resolution: "切换备用支付通道并降低网关超时阈值，监控恢复后逐步回切。",
    },
  },
  {
    incidentId: "INC-2025-033",
    title: "iOS 优惠券按钮埋点漏报",
    platform: "iOS",
    versions: ["7.2.0"],
    metricKeys: ["coupon_claim_success_rate"],
    regions: ["AU", "US"],
    userTypes: ["RETURNING"],
    components: ["AnalyticsSDK"],
    severity: "MEDIUM",
    sections: {
      symptoms: "看板显示领取成功率下降，但客服反馈和订单结果均正常。",
      root_cause: "iOS AnalyticsSDK 升级后成功事件字段被重命名，属于指标漏报而非业务失败。",
      resolution: "修复事件映射并回填指标，不执行服务端回滚。",
    },
  },
  {
    incidentId: "INC-2025-047",
    title: "新用户实验配置遗漏优惠券资格",
    platform: "Android",
    versions: ["7.2.5"],
    metricKeys: ["coupon_claim_success_rate"],
    regions: ["AU"],
    userTypes: ["NEW"],
    components: ["ExperimentService", "EligibilityService"],
    severity: "HIGH",
    sections: {
      symptoms: "只有新用户领取成功率下降，老用户和 iOS 正常。",
      root_cause: "新用户实验分流配置没有同步优惠券资格规则，服务端返回不符合领取条件。",
      resolution: "关闭错误实验分流并补齐资格配置校验。",
    },
  },
  {
    incidentId: "INC-2025-052",
    title: "CDN 缓存旧资格规则",
    platform: "Web",
    versions: ["web-2025.06"],
    metricKeys: ["coupon_claim_success_rate"],
    regions: ["SG"],
    userTypes: ["NEW", "RETURNING"],
    components: ["CDN", "EligibilityService"],
    severity: "MEDIUM",
    sections: {
      symptoms: "新规则发布后部分地区仍展示已下线优惠券，领取请求失败。",
      root_cause: "CDN 缓存 TTL 配置过长，资格规则没有及时失效。",
      resolution: "主动刷新缓存并为规则版本加入 cache key。",
    },
  },
  {
    incidentId: "INC-2025-061",
    title: "Android 登录 token 刷新风暴",
    platform: "Android",
    versions: ["7.2.7"],
    metricKeys: ["login_success_rate"],
    regions: ["AU", "US"],
    userTypes: ["RETURNING"],
    components: ["AuthService", "TokenRefresh"],
    severity: "CRITICAL",
    sections: {
      symptoms: "登录超时、重复转圈并伴随大量重试，但优惠券链路正常。",
      root_cause: "token 刷新失败触发无退避重试，形成请求风暴。",
      resolution: "加入指数退避和刷新互斥锁。",
    },
  },
  {
    incidentId: "INC-2025-073",
    title: "US 新用户优惠券库存分区不足",
    platform: "Android",
    versions: ["7.2.8"],
    metricKeys: ["coupon_claim_success_rate"],
    regions: ["US"],
    userTypes: ["NEW"],
    components: ["CouponInventory"],
    severity: "HIGH",
    sections: {
      symptoms: "美国新用户领取失败明显，其他地区和老用户正常。",
      root_cause: "US 新用户活动库存分区容量不足，领取接口返回库存耗尽。",
      resolution: "扩充库存分区并增加分群库存预警。",
    },
  },
  {
    incidentId: "INC-2025-088",
    title: "优惠券展示延迟但领取接口正常",
    platform: "Android",
    versions: ["7.2.9"],
    metricKeys: ["coupon_view_latency"],
    regions: ["AU"],
    userTypes: ["RETURNING"],
    components: ["CouponUI"],
    severity: "LOW",
    sections: {
      symptoms: "优惠券页面加载缓慢，但最终领取成功率没有变化。",
      root_cause: "图片资源体积增大导致首屏渲染延迟。",
      resolution: "压缩图片并预加载核心资源。",
    },
  },
  {
    incidentId: "INC-2026-003",
    title: "订单接口幂等键格式升级不兼容",
    platform: "Android",
    versions: ["7.2.9"],
    metricKeys: ["order_create_success_rate"],
    regions: ["AU", "US"],
    userTypes: ["NEW", "RETURNING"],
    components: ["OrderService", "IdempotencyGuard"],
    severity: "HIGH",
    sections: {
      symptoms: "订单创建出现重复处理中和超时提示。",
      root_cause: "新旧客户端生成的幂等键格式不兼容，服务端错误合并了不同订单。",
      resolution: "恢复旧格式兼容并按用户与订单联合校验。",
    },
  },
  {
    incidentId: "INC-2026-011",
    title: "Android 低端机网络超时配置过短",
    platform: "Android",
    versions: ["7.3.0-beta"],
    metricKeys: ["coupon_claim_success_rate"],
    regions: ["IN"],
    userTypes: ["NEW"],
    components: ["NetworkClient"],
    severity: "MEDIUM",
    sections: {
      symptoms: "低端设备在弱网下优惠券领取超时，服务端请求最终成功。",
      root_cause: "客户端网络超时设置缩短，响应返回前界面已显示失败。",
      resolution: "恢复超时阈值并增加弱网测试。",
    },
  },
  {
    incidentId: "INC-2026-018",
    title: "风控规则误伤高频优惠券用户",
    platform: "Android",
    versions: ["7.2.9", "7.3.0"],
    metricKeys: ["coupon_claim_success_rate"],
    regions: ["AU"],
    userTypes: ["RETURNING"],
    components: ["RiskEngine"],
    severity: "HIGH",
    sections: {
      symptoms: "高频领取老用户失败率上升，所有 Android 版本均受影响。",
      root_cause: "风控阈值调整将正常高频用户误判为滥用。",
      resolution: "回滚风控阈值并补充分群白名单。",
    },
  },
  {
    incidentId: "INC-2026-024",
    title: "消息队列积压延迟发券",
    platform: "Android",
    versions: ["7.2.9"],
    metricKeys: ["coupon_delivery_latency"],
    regions: ["US"],
    userTypes: ["NEW", "RETURNING"],
    components: ["CouponQueue"],
    severity: "HIGH",
    sections: {
      symptoms: "接口返回领取成功，但优惠券较晚出现在账户。",
      root_cause: "发券消息队列分区积压，不影响领取接口成功率。",
      resolution: "扩容消费者并重放积压消息。",
    },
  },
  {
    incidentId: "INC-2026-031",
    title: "灰度配置错误导致 Android 全量发布",
    platform: "Android",
    versions: ["7.3.0-rc"],
    metricKeys: ["crash_free_rate"],
    regions: ["AU", "US"],
    userTypes: ["NEW", "RETURNING"],
    components: ["ReleaseOrchestrator"],
    severity: "CRITICAL",
    sections: {
      symptoms: "原计划百分之十灰度的版本被推送到全部用户，崩溃率下降。",
      root_cause: "发布配置中的 rolloutPercentage 单位解析错误。",
      resolution: "暂停发布并修复百分比解析校验。",
    },
  },
  {
    incidentId: "INC-2026-039",
    title: "促销活动开始后优惠券请求自然激增",
    platform: "Android",
    versions: ["7.2.9"],
    metricKeys: ["coupon_claim_request_count"],
    regions: ["AU"],
    userTypes: ["NEW", "RETURNING"],
    components: ["CampaignService"],
    severity: "LOW",
    sections: {
      symptoms: "领取请求量快速上升，但成功率、延迟和错误率正常。",
      root_cause: "营销活动带来的预期流量增长，不属于产品事故。",
      resolution: "保持观察，无需回滚。",
    },
  },
  {
    incidentId: "INC-2026-044",
    title: "优惠券文案本地化缺失",
    platform: "Android",
    versions: ["7.3.0"],
    metricKeys: ["coupon_view_rate"],
    regions: ["JP"],
    userTypes: ["NEW"],
    components: ["Localization"],
    severity: "LOW",
    sections: {
      symptoms: "日本新用户看到英文优惠券文案，领取功能本身正常。",
      root_cause: "新文案没有进入日语资源包。",
      resolution: "补充本地化资源并热更新。",
    },
  },
  {
    incidentId: "INC-2026-050",
    title: "CouponClaim 响应字段兼容性错误",
    platform: "Android",
    versions: ["7.3.1"],
    metricKeys: ["coupon_claim_success_rate"],
    regions: ["AU", "US"],
    userTypes: ["NEW", "RETURNING"],
    components: ["CouponClaimService", "AndroidClient"],
    severity: "HIGH",
    sections: {
      symptoms: "服务端日志显示领取成功，但 Android 页面仍提示失败。",
      root_cause: "客户端没有兼容新的 success_code 字段，误把成功响应当作失败。",
      resolution: "恢复旧字段并补充契约测试。",
    },
  },
];

const feedbackTemplates = [
  "升级后优惠券按钮一直转圈，重新点击还是超时",
  "Android 7.3.0 领取优惠券失败，但昨天还正常",
  "新用户注册后看得到券，点击领取提示处理中",
  "付款流程正常，只有领券这一步失败",
  "优惠券领取成功，没有遇到问题",
  "登录页面重复加载，与优惠券无关",
  "iPhone 上领取正常，Android 朋友说一直超时",
  "美国地区新用户领取时提示库存不足",
  "页面加载有点慢，但最后成功领取",
];

export function feedbackFixtures() {
  const regions = ["AU", "US", "SG"];
  const userTypes = ["NEW", "RETURNING"];
  return Array.from({ length: 72 }, (_, index) => {
    const relevant = index % 3 !== 0;
    const platform = index % 7 === 0 ? "iOS" : "Android";
    const appVersion = relevant && platform === "Android" ? "7.3.0" : index % 2 ? "7.2.9" : "7.3.0";
    const content = feedbackTemplates[index % feedbackTemplates.length];
    return {
      id: `FB-${String(index + 1).padStart(3, "0")}`,
      timestamp: new Date(Date.parse("2026-07-26T02:05:00.000Z") + index * 60_000).toISOString(),
      platform,
      appVersion,
      region: regions[index % regions.length],
      userType: userTypes[index % userTypes.length],
      content,
      tags: relevant ? ["coupon", "claim", "timeout"] : ["control"],
      source: index % 2 ? "Support Desk" : "Community",
      sourceReference: `feedback://phase3/${index + 1}`,
    };
  });
}
