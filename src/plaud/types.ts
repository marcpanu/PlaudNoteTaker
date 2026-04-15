export interface PlaudDevice {
  sn: string;
  name: string;
  model: string;
  version_number: number;
}

export interface PlaudDeviceListResponse {
  status: number;
  msg: string;
  data_devices: PlaudDevice[];
}

export interface PlaudRecording {
  id: string;
  filename: string;
  keywords: string[];
  filesize: number;
  filetype: string;
  fullname: string;
  file_md5: string;
  ori_ready: boolean;
  version: number;
  version_ms: number;
  edit_time: number;
  edit_from: string;
  is_trash: boolean;
  start_time: number; // Unix timestamp in milliseconds
  end_time: number; // Unix timestamp in milliseconds
  duration: number; // Duration in milliseconds
  timezone: number;
  zonemins: number;
  scene: number;
  filetag_id_list: string[];
  serial_number: string;
  is_trans: boolean;
  is_summary: boolean;
}

export interface PlaudRecordingsResponse {
  status: number;
  msg: string;
  data_file_total: number;
  data_file_list: PlaudRecording[];
}

export interface PlaudTempUrlResponse {
  status: number;
  temp_url: string;
  temp_url_opus?: string;
}
