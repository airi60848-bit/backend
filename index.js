const express = require('express');
const cors = require('cors');
const axios = require('axios');
const { GoogleGenerativeAI } = require("@google/generative-ai");
const polyline = require('@mapbox/polyline'); // Required for routes
require('dotenv').config();

const app = express();
app.use(cors());
app.use(express.json());
app.get('/', (req, res) => res.status(200).send('HeatWise backend running'));

app.get('/health', (req, res) =>
  res.status(200).json({ status: 'ok', uptime: process.uptime() })
);
// Initialize Gemini AI
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);


// 1. Weather Forecast Endpoint (Open-Meteo)

app.get('/api/v1/forecast', async (req, res) => {
    try {
        const { lat, lon } = req.query;
        
        const weatherRes = await axios.get(`https://api.open-meteo.com/v1/forecast`, {
            params: {
                latitude: lat,
                longitude: lon,
                current: 'temperature_2m,relative_humidity_2m,weather_code',
                hourly: 'temperature_2m',
                timezone: 'auto'
            }
        });

        const current = weatherRes.data.current;
        const hourly = weatherRes.data.hourly;

        // Format the next 5 hours for the forecast
        const forecast = [];
        for (let i = 0; i < 5; i++) {
            forecast.push({
                time: hourly.time[i].split('T')[1], // Extracts "14:00"
                temp: Math.round(hourly.temperature_2m[i])
            });
        }

        const temp = Math.round(current.temperature_2m);
        const safetyMessage = temp > 35 
            ? "Extreme heat! Avoid going outside right now." 
            : "Weather is manageable. Stay hydrated.";
            
        // Extract city/timezone name roughly
        const cityName = weatherRes.data.timezone.split('/')[1]?.replace(/_/g, ' ') || "My Location";

        res.json({
            cityName: cityName,
            current: temp,
            safetyMessage: safetyMessage,
            forecast: forecast
        });
    } catch (error) {
        console.error("Weather API Error:", error.message);
        res.status(500).json({ error: "Failed to fetch weather data" });
    }
});


// Shaded Routes Endpoint (OpenRouteService)

app.post('/api/v1/routes/shaded', async (req, res) => {
    try {
        const { start_lat, start_lon, end_lat, end_lon } = req.body;

        // Call OpenRouteService for a real walking route
        const orsRes = await axios.post(
            'https://api.openrouteservice.org/v2/directions/foot-walking/geojson',
            {
                coordinates: [[start_lon, start_lat], [end_lon, end_lat]]
            },
            {
                headers: {
                    'Authorization': process.env.ORS_API_KEY,
                    'Content-Type': 'application/json'
                }
            }
        );

        const routeData = orsRes.data.features[0];
        const geometry = routeData.geometry; // GeoJSON LineString
        const timeSeconds = routeData.properties.summary.duration;
        
        // OpenRouteService 
        const encodedPolyline = polyline.encode(
            geometry.coordinates.map(coord => [coord[1], coord[0]])
        );

        // Create two route options based on the real path
        const routes = [
            {
                id: "route1",
                name: "Shaded Park Path",
                shade_percent: 75,
                time_minutes: Math.ceil(timeSeconds / 60) + 5, 
                points_earned: 15,
                exposure_warning: null,
                polyline: encodedPolyline
            },
            {
                id: "route2",
                name: "Direct Main Road",
                shade_percent: 20,
                time_minutes: Math.ceil(timeSeconds / 60),
                points_earned: 5,
                exposure_warning: "High sun exposure",
                polyline: encodedPolyline 
            }
        ];

        res.json(routes);
    } catch (error) {
        console.error("Route API Error:", error.response?.data || error.message);
        res.status(500).json({ error: "Failed to fetch routes from OpenRouteService" });
    }
});


//  Cooling Centers Endpoint (OSM Overpass)

app.get('/api/v1/cooling-centers', async (req, res) => {
    const lat = parseFloat(req.query.lat);
    const lon = parseFloat(req.query.lon);
    const radius = parseInt(req.query.radius) || 2000;

    if (!isFinite(lat) || !isFinite(lon)) {
        return res.status(400).json({ error: 'lat and lon are required' });
    }

    const query = `
        [out:json][timeout:15];
        (
          nwr["amenity"="library"](around:${radius},${lat},${lon});
          nwr["shop"="mall"](around:${radius},${lat},${lon});
          nwr["amenity"="community_centre"](around:${radius},${lat},${lon});
        );
        out center 50;
    `;

    const mirrors = [
        'https://overpass.kumi.systems/api/interpreter',
        'https://overpass-api.de/api/interpreter',
        'https://overpass.private.coffee/api/interpreter',
    ];

    try {
        let overpassRes = null;
        for (const url of mirrors) {
            try {
                overpassRes = await axios.post(
                    url,
                    new URLSearchParams({ data: query }).toString(),
                    {
                        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
                        timeout: 20000,
                    }
                );
                break;
            } catch (e) {
                console.warn(`Overpass mirror failed: ${url} - ${e.message}`);
            }
        }

        if (!overpassRes) {
            return res.status(503).json({ error: 'All Overpass mirrors failed' });
        }

        const elements = overpassRes.data.elements || [];
        if (elements.length === 0) return res.json([]);

        const centers = elements
            .map(el => {
                const elLat = el.lat ?? el.center?.lat;
                const elLon = el.lon ?? el.center?.lon;
                if (elLat == null || elLon == null) return null;

                const dLat = (elLat - lat) * 111.32;
                const dLon = (elLon - lon) * 111.32 * Math.cos(lat * Math.PI / 180);
                const distanceKm = Math.sqrt(dLat * dLat + dLon * dLon);
                const walkMinutes = Math.max(1, Math.round(distanceKm * 12));

                const type = el.tags?.amenity || el.tags?.shop || 'cooling_center';
                const name = el.tags?.name
                    || `Local ${type.charAt(0).toUpperCase() + type.slice(1).replace('_', ' ')}`;

                return { name, lat: elLat, lon: elLon, walkMinutes };
            })
            .filter(Boolean)
            .sort((a, b) => a.walkMinutes - b.walkMinutes);

        res.json(centers);
    } catch (error) {
        console.error('Cooling centers error:', error.message);
        res.status(503).json({ error: 'Failed to fetch cooling centers' });
    }
});


//  AI Advisor Endpoint (Gemini)

app.post('/api/v1/advisor', async (req, res) => {
    const { message, lat, lon } = req.body ?? {};

    if (typeof message !== 'string' || message.trim() === ''
        || !isFinite(lat) || !isFinite(lon)) {
        return res.status(400).json({ reply: 'Invalid request.' });
    }

    try {
        const model = genAI.getGenerativeModel({ model: 'gemini-2.0-flash' });
        const prompt = `You are a concise heat safety advisor. The user is at lat: ${lat}, lon: ${lon}. Answer in max 3 sentences. User question: "${message}"`;

        const result = await model.generateContent(prompt);
        const response = await result.response;

        res.json({ reply: response.text() });
    } catch (error) {
        console.error('Gemini error:', error.message);
        
        res.status(200).json({
            reply: 'My AI systems are briefly offline. Try again in a moment.'
        });
    }
});



const PORT = process.env.PORT || 3000;
app.listen(PORT, "0.0.0.0", () => {
    console.log(`Production backend running on port ${PORT}`);
});