import { fetchJson } from '../util';

// WMO weather code -> [中文, icon key]
const WMO: Record<number, [string, string]> = {
  0: ['晴', 'sun'], 1: ['大致晴', 'sun-cloud'], 2: ['多云', 'sun-cloud'], 3: ['阴', 'cloud'],
  45: ['雾', 'fog'], 48: ['冻雾', 'fog'],
  51: ['小毛毛雨', 'drizzle'], 53: ['毛毛雨', 'drizzle'], 55: ['大毛毛雨', 'drizzle'], 56: ['冻毛毛雨', 'drizzle'], 57: ['冻毛毛雨', 'drizzle'],
  61: ['小雨', 'rain'], 63: ['中雨', 'rain'], 65: ['大雨', 'rain-heavy'], 66: ['冻雨', 'rain'], 67: ['冻雨', 'rain-heavy'],
  71: ['小雪', 'snow'], 73: ['中雪', 'snow'], 75: ['大雪', 'snow'], 77: ['雪粒', 'snow'],
  80: ['阵雨', 'shower'], 81: ['强阵雨', 'shower'], 82: ['暴雨', 'rain-heavy'], 85: ['阵雪', 'snow'], 86: ['强阵雪', 'snow'],
  95: ['雷雨', 'storm'], 96: ['雷雨冰雹', 'storm'], 99: ['强雷雨冰雹', 'storm'],
};
export const wmo = (c: number) => WMO[c] || ['未知', 'cloud'];

export const weatherSource = {
  key: (p: any) => `weather:${(+p.lat).toFixed(3)},${(+p.lon).toFixed(3)}`,
  ttlSec: 15 * 60,
  async fetch(p: any, tz: string) {
    const q = new URLSearchParams({
      latitude: String(p.lat), longitude: String(p.lon), timezone: tz, forecast_days: '8',
      current: 'temperature_2m,apparent_temperature,relative_humidity_2m,precipitation,weather_code,wind_speed_10m,wind_direction_10m,is_day,uv_index',
      hourly: 'temperature_2m,precipitation_probability,weather_code',
      daily: 'weather_code,temperature_2m_max,temperature_2m_min,precipitation_probability_max,precipitation_sum,sunrise,sunset,uv_index_max',
    });
    const r = await fetchJson<any>(`https://api.open-meteo.com/v1/forecast?${q}`);
    const cur = r.current;
    const nowHour = cur.time.slice(0, 13);
    const startIdx = Math.max(0, r.hourly.time.findIndex((t: string) => t.slice(0, 13) >= nowHour));
    const hourly = r.hourly.time.slice(startIdx, startIdx + 24).map((t: string, i: number) => ({
      t, temp: Math.round(r.hourly.temperature_2m[startIdx + i]), pop: r.hourly.precipitation_probability[startIdx + i] ?? 0,
      code: r.hourly.weather_code[startIdx + i], icon: wmo(r.hourly.weather_code[startIdx + i])[1],
    }));
    const daily = r.daily.time.map((d: string, i: number) => ({
      d, max: Math.round(r.daily.temperature_2m_max[i]), min: Math.round(r.daily.temperature_2m_min[i]),
      pop: r.daily.precipitation_probability_max[i] ?? 0, rain: r.daily.precipitation_sum[i] ?? 0,
      code: r.daily.weather_code[i], text: wmo(r.daily.weather_code[i])[0], icon: wmo(r.daily.weather_code[i])[1],
      sunrise: r.daily.sunrise[i]?.slice(11, 16), sunset: r.daily.sunset[i]?.slice(11, 16), uv: r.daily.uv_index_max[i],
    }));
    // A one-line human summary for the next 12 hours.
    const next12 = hourly.slice(0, 12);
    const rainy = next12.filter((h: any) => h.pop >= 50);
    let summary = '';
    if (rainy.length) summary = `${rainy[0].t.slice(11, 13)} 点起可能下雨（${Math.max(...rainy.map((h: any) => h.pop))}%）`;
    else if (daily[0].uv >= 8) summary = `紫外线很强（UV ${Math.round(daily[0].uv)}），出门防晒`;
    else summary = `未来 12 小时无雨`;
    return {
      now: {
        temp: Math.round(cur.temperature_2m), feels: Math.round(cur.apparent_temperature), humidity: cur.relative_humidity_2m,
        wind: Math.round(cur.wind_speed_10m), windDir: cur.wind_direction_10m, code: cur.weather_code,
        text: wmo(cur.weather_code)[0], icon: wmo(cur.weather_code)[1], isDay: !!cur.is_day, uv: cur.uv_index,
      },
      hourly, daily, summary,
    };
  },
};
