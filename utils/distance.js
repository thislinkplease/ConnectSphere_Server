/**
 * Calculate great-circle distance between two points using Haversine formula
 * This calculates the straight-line distance (as the crow flies)
 * 
 * Uses a mean Earth radius of 6371.0088 km, which is commonly used for geodetic
 * calculations and provides good accuracy for most applications. Note that this
 * is an approximation since the Earth is not a perfect sphere (WGS84 defines
 * semi-major axis: 6378.137 km, semi-minor axis: 6356.752 km).
 * 
 * @param {number} lat1 - Latitude of first point in decimal degrees
 * @param {number} lon1 - Longitude of first point in decimal degrees
 * @param {number} lat2 - Latitude of second point in decimal degrees
 * @param {number} lon2 - Longitude of second point in decimal degrees
 * @returns {number} Distance in kilometers
 */
function calculateDistance(lat1, lon1, lat2, lon2) {
   // Mean Earth radius in km (commonly used for geodetic calculations)
   // This provides good accuracy for most applications
   const R = 6371.0088;
   
   // Convert latitude and longitude differences to radians
   const dLat = ((lat2 - lat1) * Math.PI) / 180;
   const dLon = ((lon2 - lon1) * Math.PI) / 180;
   
   // Convert latitudes to radians
   const lat1Rad = (lat1 * Math.PI) / 180;
   const lat2Rad = (lat2 * Math.PI) / 180;

   // Haversine formula for great-circle distance
   const a =
      Math.sin(dLat / 2) ** 2 +
      Math.cos(lat1Rad) * Math.cos(lat2Rad) * Math.sin(dLon / 2) ** 2;

   const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
   
   return R * c;
}

module.exports = { calculateDistance };
