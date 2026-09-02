// 拾光记 · 天气模块
// 数据源：Open-Meteo（免费、无需 API key，分享版友好）

import {
  findAdministrativeRegion,
  formatAdministrativeRegion,
  getAdministrativeRegion,
} from "./administrative-divisions.js";
// 职责：城市→经纬度（geocoding）、查天气（forecast）、天气→氛围文本（轻量角色扮演方向）
// 设计：缓存由外部（data.js）管理，本模块只做「查」和「翻译」，纯函数可测。

const GEO_URL = "https://geocoding-api.open-meteo.com/v1/search";
const FORECAST_URL = "https://api.open-meteo.com/v1/forecast";

// WMO weather code → 中文氛围描述（含「动作方向」，供助手组织语言，不照抄）
// 参考 https://open-meteo.com/en/docs （wmo codes）
const WMO_MAP = {
  0: "晴空万里，阳光正好",
  1: "大晴天，就是云不多",
  2: "多云，偶尔有云飘过",
  3: "阴天，天灰蒙蒙的",
  45: "有雾，看远处模模糊糊",
  48: "有雾凇，白茫茫一片",
  51: "毛毛雨，细细的飘",
  53: "小雨，淅淅沥沥",
  55: "中雨，雨点密起来了",
  56: "冻毛毛雨，有点冷",
  57: "冻雨，路上要小心滑",
  61: "小雨，得打伞了",
  63: "中雨，雨声哗哗",
  65: "大雨，哗啦哗啦的",
  66: "冻雨，冷飕飕的",
  67: "冻雨，路滑别摔",
  71: "小雪，轻轻的飘",
  73: "中雪，地上白了",
  75: "大雪，雪片大得很",
  77: "米雪，细细碎碎",
  80: "阵雨，一阵一阵的",
  81: "强阵雨，说来就来",
  82: "暴雨，哗的一下",
  85: "阵雪，断断续续",
  86: "强阵雪，雪势不小",
  95: "雷阵雨，轰隆隆的",
  96: "雷阵雨夹冰雹，小心点",
  99: "强雷暴带冰雹，别出门",
};

// 默认（未知 code）兜底
const WMO_DEFAULT = "天气有点变化";

// 接受设置里的 latitude/longitude，也兼容内部调用常用的 lat/lon。
export function normalizeWeatherCoordinates(value) {
  if (!value || typeof value !== "object") return null;
  const rawLat = value.latitude ?? value.lat;
  const rawLon = value.longitude ?? value.lon;
  if (rawLat === "" || rawLat == null || rawLon === "" || rawLon == null) return null;
  const lat = Number(rawLat);
  const lon = Number(rawLon);
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
  if (lat < -90 || lat > 90 || lon < -180 || lon > 180) return null;
  return { lat, lon };
}

// 统一解析当前天气地点。旧版只保存 weatherLocation，新版还保存 weatherArea。
// 未能匹配旧地点时保留原文字，仍可走城市级 Open-Meteo 查询。
export function resolveWeatherLocation(settings = {}) {
  const rawLocation = String(settings.weatherLocation || "").trim();
  const storedCode = settings.weatherArea?.code || settings.weatherRegion?.code;
  const area = getAdministrativeRegion(storedCode) || findAdministrativeRegion(rawLocation);
  const location = area ? formatAdministrativeRegion(area) : rawLocation;
  const coordinates = area
    ? { lat: area.latitude, lon: area.longitude }
    : normalizeWeatherCoordinates(settings.weatherArea || settings.weatherCoordinates);
  return { location, rawLocation, area, coordinates };
}

export function weatherCacheMatches(cache, settings = {}) {
  if (!cache || !cache.result) return false;
  const config = resolveWeatherLocation(settings);
  const locations = new Set([config.location, config.rawLocation].filter(Boolean));
  return locations.has(String(cache.location || "").trim());
}

// 旧缓存只有 place/line/temp，没有 code/isDay；补出可识别的状态并修复旧版晴天夜间矛盾文案。
export function normalizeWeatherResult(result) {
  if (!result || typeof result !== "object") return null;
  const normalized = { ...result };
  let line = String(normalized.line || "");
  if (line.includes("阳光正好") && line.includes("天已经黑")) {
    line = line
      .replace("晴空万里，阳光正好", "晴朗")
      .replace("，天已经黑了", "，夜色清亮");
  } else if (line.includes("大晴天，就是云不多") && line.includes("天已经黑")) {
    line = line
      .replace("大晴天，就是云不多", "晴朗，云不多")
      .replace("，天已经黑了", "，夜色清亮");
  }
  if (line) normalized.line = line;

  const hasCode = normalized.code !== "" && normalized.code != null && Number.isFinite(Number(normalized.code));
  if (!hasCode) {
    if (/雷|冰雹/.test(line)) normalized.code = 95;
    else if (/雨/.test(line)) normalized.code = 61;
    else if (/雪|米雪/.test(line)) normalized.code = 73;
    else if (/雾|雾凇/.test(line)) normalized.code = 45;
    else if (/多云|阴天/.test(line)) normalized.code = 2;
    else if (/云不多|大晴天/.test(line)) normalized.code = 1;
    else if (/晴|阳光/.test(line)) normalized.code = 0;
  }
  if (typeof normalized.isDay !== "boolean" && normalized.isDay !== 0 && normalized.isDay !== 1) {
    if (/天已经黑|夜/.test(line)) normalized.isDay = false;
    else if (/清晨|正午|傍晚/.test(line)) normalized.isDay = true;
  } else if (normalized.isDay === 0 || normalized.isDay === 1) {
    normalized.isDay = normalized.isDay === 1;
  }
  return normalized;
}

// 从天气数据里挑出「最值得说」的氛围信息
// 返回 { line, temp, feelsLike }，line 是给助手的一句话方向
export function translateWeatherToMood(data) {
  if (!data || !data.current) return null;
  const code = Number(data.current.weather_code);
  const temp = Math.round(data.current.temperature_2m);
  const isDay = data.current.is_day === 1;
  const now = data.current.time ? new Date(data.current.time) : new Date();
  const hour = now.getHours();

  // 晴天的白天和夜晚用不同意象，避免出现「阳光正好，天已经黑了」的自相矛盾。
  let base = WMO_MAP[code] || WMO_DEFAULT;
  if (code === 0 && isDay) base = "晴空万里，阳光正好";
  if (code === 0 && !isDay) base = "晴朗";
  if (code === 1 && !isDay) base = "晴朗，云不多";

  // 组装一句话：包含「状态 + 温度 + 时段感」，让助手有素材自己发挥
  let line = base;
  if (temp !== null && !isNaN(temp)) {
    line += `，${temp}°C`;
  }
  // 时间感：深夜/清晨/正午/傍晚，给助手「扒头看窗外」的语境
  if (!isDay) {
    line += code === 0 ? "，夜色清亮" : "，天已经黑了";
  } else if (hour >= 5 && hour < 8) {
    line += "，清晨刚亮";
  } else if (hour >= 11 && hour < 14) {
    line += "，正午阳光";
  } else if (hour >= 17 && hour < 20) {
    line += "，傍晚时分";
  }

  return { line, temp, code, isDay };
}

// 城市名 → 经纬度。Open-Meteo geocoding 对中国只到城市级，取第一个结果。
// @returns {Promise<{lat:number, lon:number, name:string}|null>}
export async function geocode(city, fetcher = defaultFetch) {
  const name = String(city || "").trim();
  if (!name) return null;
  try {
    const url = `${GEO_URL}?name=${encodeURIComponent(name)}&count=1&format=json&language=zh`;
    const json = await fetcher(url, 8000);
    const rows = json && Array.isArray(json.results) ? json.results : [];
    if (!rows.length) return null;
    const r = rows[0];
    if (typeof r.latitude !== "number" || typeof r.longitude !== "number") return null;
    return { lat: r.latitude, lon: r.longitude, name: r.name || name };
  } catch {
    return null; // 网络失败静默
  }
}

// 经纬度 → 天气。只取当前 + 今日概要（注入只需要"现在的氛围"）
// @returns {Promise<object|null>}
export async function fetchWeather(lat, lon, fetcher = defaultFetch) {
  const coordinates = normalizeWeatherCoordinates({ lat, lon });
  if (!coordinates) return null;
  try {
    const url =
      `${FORECAST_URL}?latitude=${coordinates.lat}&longitude=${coordinates.lon}` +
      `&current=temperature_2m,weather_code,is_day` +
      `&daily=weather_code,temperature_2m_max,temperature_2m_min` +
      `&timezone=auto&forecast_days=1`;
    const json = await fetcher(url, 8000);
    if (!json || !json.current) return null;
    return json;
  } catch {
    return null; // 网络失败静默
  }
}

// 统一入口：给注入用。负责「读缓存→过期/没有就查→写缓存→返回」
// 由外部传入 data（有 getWeatherCache/setWeatherCache）和 location，便于测试
// @param {object} opts { data, location, coordinates, now, fetcher, noCache } noCache=true 时不读写缓存（测试用）
// @returns {Promise<{place:string, line:string, temp:number}|null>} null=没配置/失败
export async function getWeatherForInject({ data, location, coordinates, now = new Date(), fetcher, noCache = false }) {
  const settings = data.getSettings();
  const configured = resolveWeatherLocation(settings);
  const requestedLocation = String(location || "").trim();
  const loc = requestedLocation || configured.location;
  if (!loc) return null;
  const usesConfiguredLocation = !requestedLocation || requestedLocation === configured.location || requestedLocation === configured.rawLocation;
  const requestedCoordinates = normalizeWeatherCoordinates(coordinates);
  const targetCoordinates = requestedCoordinates || (usesConfiguredLocation ? configured.coordinates : null);
  const intervalMs = (settings.weatherIntervalHours || 3) * 3600 * 1000;

  // 缓存有效：同地点 + 未过期（noCache 时跳过读缓存）。旧缓存没有 coordinates 也继续兼容。
  if (!noCache) {
    const cache = data.getWeatherCache();
    const locationMatches = cache && [loc, configured.location, configured.rawLocation]
      .filter(Boolean)
      .includes(String(cache.location || "").trim());
    if (locationMatches && now.getTime() - cache.fetchedAt < intervalMs) {
      return normalizeWeatherResult(cache.result);
    }
  }

  // 新版区县设置直接用中心点；旧版地点仍拆出城市走 Open-Meteo 地名搜索。
  const geo = targetCoordinates || await geocode(extractCity(loc), fetcher);
  if (!geo) return null;
  const weather = await fetchWeather(geo.lat, geo.lon, fetcher);
  if (!weather) return null;

  const mood = translateWeatherToMood(weather);
  if (!mood) return null;

  const result = {
    place: loc, // 展示用用户填的完整地名（如「成都 武侯区」）
    line: mood.line,
    temp: mood.temp,
    code: mood.code,
    isDay: mood.isDay,
  };

  // 写缓存（noCache 或失败时不阻塞注入）
  if (!noCache) {
    try {
      await data.setWeatherCache({
        location: loc,
        coordinates: { lat: geo.lat, lon: geo.lon },
        fetchedAt: now.getTime(),
        result,
      });
    } catch {
      // 缓存写失败忽略
    }
  }
  return result;
}

// 从地点文字拆出城市：兼容「成都 武侯区」和「四川省 成都市 武侯区」。
export function extractCity(loc) {
  const parts = String(loc || "").split(/\s+/).filter(Boolean);
  if (parts.length >= 2 && /(?:省|自治区|特别行政区)$/.test(parts[0])) return parts[1];
  return parts[0] || String(loc || "").trim();
}

// 默认 fetch 实现（带超时，Node 环境）
async function defaultFetch(url, timeoutMs) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: ctrl.signal, headers: { "Accept": "application/json" } });
    if (!res.ok) throw new Error("HTTP " + res.status);
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}
