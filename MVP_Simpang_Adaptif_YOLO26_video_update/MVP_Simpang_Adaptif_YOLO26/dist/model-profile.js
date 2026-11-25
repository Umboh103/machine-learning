// Change detector settings once per checkpoint, preserving camera geometry and control settings.
export function applyModelProfile(config, profile) {
  if (!profile?.id || config.detectorModel === profile.id) return config;
  return {...config, detectorModel: profile.id,
    vehicleClasses: [...profile.vehicleClasses], confidence: profile.confidence,
    imgsz: Array.isArray(profile.imgsz) ? [...profile.imgsz] : profile.imgsz};
}
