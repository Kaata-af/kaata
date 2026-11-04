package visit

// AcquisitionSources are the channel tags written by Kaata's download links.
// Keep these separate from the open-ended campaign slugs on printed QR links.
func AcquisitionSources() []string {
	return []string{"facebook_ads", "organic_posts", "bill_share"}
}
