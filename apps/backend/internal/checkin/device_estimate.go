package checkin

// validatedDeviceEstimate accepts only the mobile client's SHA-256 digest and
// its matching platform namespace. Invalid optional telemetry must not fail a
// check-in or erase a digest sent by a newer client. In particular, accepting a
// raw Android ID or IDFV here would retain an unnecessary OS identifier.
func validatedDeviceEstimate(platform string, hash, kind *string) (*string, *string) {
	if hash == nil || kind == nil || len(*hash) != 64 {
		return nil, nil
	}
	if !((platform == "android" && *kind == "android_id") ||
		(platform == "ios" && *kind == "ios_idfv")) {
		return nil, nil
	}
	for _, char := range *hash {
		if !(char >= '0' && char <= '9') && !(char >= 'a' && char <= 'f') {
			return nil, nil
		}
	}
	return hash, kind
}
