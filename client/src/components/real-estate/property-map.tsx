import { useEffect, useRef, useState } from 'react';
import { authedFetch } from "@/lib/authed-fetch";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Slider } from "@/components/ui/slider";
import { Card, CardContent } from "@/components/ui/card";
import { Search, MapPin, Sliders, Home, DollarSign } from 'lucide-react';

interface PropertyMapProps {
  apiKey?: string;
}

export default function PropertyMap({ apiKey }: PropertyMapProps) {
  const mapContainerRef = useRef<HTMLDivElement>(null);
  const [isMapLoaded, setIsMapLoaded] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const [priceRange, setPriceRange] = useState([0, 1000000]);
  const [bedrooms, setBedrooms] = useState([1, 5]);
  const [mapError, setMapError] = useState<string | null>(null);
  
  useEffect(() => {
    // Check if API key is available
    if (!apiKey) {
      setMapError('Zillow API key is required for the property map.');
      return;
    }
    
    // Load the Zillow map
    const loadZillowMap = async () => {
      try {
        // In a real implementation, this would initialize the Zillow map API
        // using the provided API key and create the interactive map
        
        // For now, we'll simulate the map loading delay
        setTimeout(() => {
          if (mapContainerRef.current) {
            // This is where we'd actually initialize the map
            setIsMapLoaded(true);
          }
        }, 1500);
        
        // When using the actual Zillow API, you'd do something like:
        // const script = document.createElement('script');
        // script.src = `https://www.zillow.com/howto/api/ZillowMap.js?apikey=${apiKey}`;
        // script.async = true;
        // script.onload = () => initialize the map
        // document.body.appendChild(script);
        
      } catch (error) {
        console.error('Failed to load Zillow map:', error);
        setMapError('Failed to load the property map. Please try again later.');
      }
    };
    
    loadZillowMap();
    
    // Cleanup function
    return () => {
      // Cleanup code for Zillow map if needed
    };
  }, [apiKey]);
  
  const handleSearch = async () => {
    try {
      // This triggers a search with the Zillow API using the searchQuery
      
      // Make API call to our backend, which will call Zillow API
      const response = await authedFetch('/api/properties/search', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          location: searchQuery,
          priceMin: priceRange[0],
          priceMax: priceRange[1],
          bedroomsMin: bedrooms[0],
          bedroomsMax: bedrooms[1]
        }),
      });
      
      if (!response.ok) {
        throw new Error('Failed to search properties');
      }
      
      const data = await response.json();
      
      // In a real implementation, you would update the map with the results
      setIsMapLoaded(true);
    } catch (error) {
      console.error('Error searching properties:', error);
      setMapError('Failed to search properties. Please try again.');
    }
  };
  
  const [isDrawingMode, setIsDrawingMode] = useState(false);
  
  const handleDrawArea = () => {
    // Toggle drawing mode on the map
    setIsDrawingMode(!isDrawingMode);
    
    // In a real implementation with Zillow's mapping API, this would enable drawing tools
    // For example:
    // if (mapInstance) {
    //   mapInstance.setDrawingMode(!isDrawingMode ? 'polygon' : null);
    // }
  };
  
  return (
    <div className="w-full h-full flex flex-col">
      <div className="flex flex-col md:flex-row gap-4 mb-4">
        <div className="flex-grow flex">
          <div className="relative w-full">
            <Input
              type="text"
              placeholder="Enter location, address, or ZIP code"
              className="pl-10"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && handleSearch()}
            />
            <Search className="absolute left-3 top-1/2 transform -translate-y-1/2 h-4 w-4 text-gray-400" />
          </div>
          <Button className="ml-2" onClick={handleSearch}>
            Search
          </Button>
        </div>
        
        <Button 
          variant={isDrawingMode ? "default" : "outline"} 
          onClick={handleDrawArea} 
          className={`flex items-center ${isDrawingMode ? "bg-primary text-white" : ""}`}
        >
          <MapPin className="mr-2 h-4 w-4" />
          {isDrawingMode ? "Cancel Drawing" : "Draw Area"}
        </Button>
      </div>
      
      <div className="grid grid-cols-1 md:grid-cols-3 gap-4 mb-4">
        <Card>
          <CardContent className="pt-6">
            <div className="space-y-4">
              <div className="flex items-center justify-between">
                <Label className="flex items-center">
                  <DollarSign className="h-4 w-4 mr-2" />
                  Price Range
                </Label>
                <span className="text-sm text-gray-500">
                  ${priceRange[0].toLocaleString()} - ${priceRange[1].toLocaleString()}
                </span>
              </div>
              <Slider
                defaultValue={[100000, 1000000]}
                max={2000000}
                step={25000}
                value={priceRange}
                onValueChange={setPriceRange}
              />
            </div>
          </CardContent>
        </Card>
        
        <Card>
          <CardContent className="pt-6">
            <div className="space-y-4">
              <div className="flex items-center justify-between">
                <Label className="flex items-center">
                  <Home className="h-4 w-4 mr-2" />
                  Bedrooms
                </Label>
                <span className="text-sm text-gray-500">
                  {bedrooms[0]} - {bedrooms[1]}+
                </span>
              </div>
              <Slider
                defaultValue={[1, 5]}
                min={1}
                max={10}
                step={1}
                value={bedrooms}
                onValueChange={setBedrooms}
              />
            </div>
          </CardContent>
        </Card>
        
        <Card>
          <CardContent className="pt-6 flex items-center justify-center">
            <Button className="w-full" variant="outline">
              <Sliders className="mr-2 h-4 w-4" />
              More Filters
            </Button>
          </CardContent>
        </Card>
      </div>
      
      <div className="flex-grow bg-gray-100 rounded-lg relative border border-gray-200" ref={mapContainerRef}>
        {mapError ? (
          <div className="absolute inset-0 flex items-center justify-center">
            <div className="text-center p-6 max-w-md">
              <div className="bg-red-100 text-red-800 p-4 rounded-lg mb-4">
                <p>{mapError}</p>
              </div>
              <p className="text-gray-600 mb-4">
                To enable the interactive property map, a valid Zillow API key is required.
              </p>
              <div className="space-y-4">
                <Input 
                  type="password" 
                  placeholder="Enter Zillow API Key" 
                  className="w-full" 
                  onChange={(e) => {
                    if (e.target.value) {
                      setMapError(null);
                      setIsMapLoaded(true);
                    }
                  }}
                />
                <Button variant="default" className="w-full" onClick={() => window.location.reload()}>
                  Activate Map
                </Button>
              </div>
            </div>
          </div>
        ) : !isMapLoaded ? (
          <div className="absolute inset-0 flex flex-col items-center justify-center">
            <div className="w-16 h-16 border-t-4 border-primary border-solid rounded-full animate-spin mb-4"></div>
            <p className="text-gray-600">Loading property map...</p>
          </div>
        ) : (
          <div className="absolute inset-0 flex items-center justify-center">
            {isDrawingMode ? (
              <div className="text-center max-w-md">
                <div className="bg-primary/90 text-white p-6 rounded-lg shadow-md">
                  <p className="text-white font-semibold mb-2">Drawing Mode Active</p>
                  <p className="text-white/90 mb-4">
                    Click on the map to start drawing a custom search area. Click multiple points to create a polygon shape, and click the first point to complete the area.
                  </p>
                  <div className="bg-white/20 p-3 rounded text-sm">
                    Tip: The more precise your drawn area, the more accurate your search results will be.
                  </div>
                </div>
              </div>
            ) : (
              <div className="text-center max-w-md">
                {/* This is a placeholder for the actual map */}
                <div className="bg-white/90 p-6 rounded-lg shadow-md">
                  <p className="text-gray-800 font-semibold mb-2">Interactive Property Map</p>
                  <p className="text-gray-600 mb-4">
                    In the actual implementation, this area would display an interactive Zillow map with property listings.
                  </p>
                  <div className="grid grid-cols-2 gap-3 mb-4">
                    <div className="bg-blue-100 text-blue-800 p-2 rounded text-sm">304 Properties</div>
                    <div className="bg-green-100 text-green-800 p-2 rounded text-sm">$350k Avg. Price</div>
                  </div>
                  <p className="text-xs text-gray-500">
                    Data provided by Zillow API
                  </p>
                </div>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}