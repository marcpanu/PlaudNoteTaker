import type {
  PlaudDeviceListResponse,
  PlaudRecording,
  PlaudRecordingsResponse,
  PlaudTempUrlResponse,
} from "./types.js";

const DEFAULT_API_BASE = "https://api.plaud.ai";
const MAX_RETRIES = 3;
const INITIAL_RETRY_DELAY = 1000;

export class PlaudClient {
  private bearerToken: string;
  private apiBase: string;

  constructor(bearerToken: string, apiBase: string = DEFAULT_API_BASE) {
    this.bearerToken = bearerToken;
    this.apiBase = apiBase;
  }

  private async request<T>(
    path: string,
    options: RequestInit = {},
  ): Promise<T> {
    const url = `${this.apiBase}${path}`;
    let lastError: Error | null = null;

    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      try {
        const response = await fetch(url, {
          ...options,
          headers: {
            Authorization: `Bearer ${this.bearerToken}`,
            "Content-Type": "application/json",
            ...options.headers,
          },
        });

        if (response.status === 429) {
          const retryAfter = response.headers.get("Retry-After");
          const delay = retryAfter
            ? parseInt(retryAfter, 10) * 1000
            : INITIAL_RETRY_DELAY * Math.pow(2, attempt);
          console.warn(
            `Rate limited, retrying in ${delay}ms (attempt ${attempt + 1}/${MAX_RETRIES})`,
          );
          await this.sleep(delay);
          continue;
        }

        if (response.status >= 500 && attempt < MAX_RETRIES) {
          const delay = INITIAL_RETRY_DELAY * Math.pow(2, attempt);
          console.warn(
            `Server error ${response.status}, retrying in ${delay}ms (attempt ${attempt + 1}/${MAX_RETRIES})`,
          );
          await this.sleep(delay);
          continue;
        }

        if (!response.ok) {
          const body = await response.text();
          throw new Error(
            `Plaud API error ${response.status}: ${body}`,
          );
        }

        return (await response.json()) as T;
      } catch (error) {
        if (error instanceof TypeError && attempt < MAX_RETRIES) {
          const delay = INITIAL_RETRY_DELAY * Math.pow(2, attempt);
          console.warn(
            `Network error, retrying in ${delay}ms (attempt ${attempt + 1}/${MAX_RETRIES})`,
          );
          await this.sleep(delay);
          lastError = error;
          continue;
        }
        throw error;
      }
    }

    throw lastError ?? new Error("Request failed after retries");
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  async testConnection(): Promise<boolean> {
    try {
      await this.listDevices();
      return true;
    } catch {
      return false;
    }
  }

  async listDevices(): Promise<PlaudDeviceListResponse> {
    return this.request<PlaudDeviceListResponse>("/device/list");
  }

  async getRecordings(
    skip = 0,
    limit = 99999,
    isTrash = false,
    sortBy = "edit_time",
    isDesc = true,
  ): Promise<PlaudRecordingsResponse> {
    const params = new URLSearchParams({
      skip: String(skip),
      limit: String(limit),
      is_trash: String(isTrash),
      sort_by: sortBy,
      is_desc: String(isDesc),
    });
    return this.request<PlaudRecordingsResponse>(
      `/file/simple/web?${params}`,
    );
  }

  async getTempUrl(
    fileId: string,
    isOpus = true,
  ): Promise<PlaudTempUrlResponse> {
    const params = new URLSearchParams({
      is_opus: isOpus ? "1" : "0",
    });
    return this.request<PlaudTempUrlResponse>(
      `/file/temp-url/${fileId}?${params}`,
    );
  }

  async downloadRecording(
    fileId: string,
    preferOpus = true,
  ): Promise<Buffer> {
    const tempUrl = await this.getTempUrl(fileId, preferOpus);
    const url =
      preferOpus && tempUrl.temp_url_opus
        ? tempUrl.temp_url_opus
        : tempUrl.temp_url;

    const response = await fetch(url);
    if (!response.ok) {
      throw new Error(
        `Failed to download recording: ${response.status}`,
      );
    }

    return Buffer.from(await response.arrayBuffer());
  }

  async getNewRecordings(
    processedIds: Set<string>,
  ): Promise<PlaudRecording[]> {
    const response = await this.getRecordings();
    return response.data_file_list.filter(
      (r) => !processedIds.has(r.id) && !r.is_trash,
    );
  }
}
