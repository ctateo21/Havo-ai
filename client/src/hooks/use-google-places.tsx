import { useCallback, useEffect, useRef, useState } from 'react';
import { loadGoogleMapsApi } from '@/lib/script-loader';
import {
  addressWithUnit,
  componentsWithUnit,
  parsePlacesUnit,
} from '@/lib/google-places-unit';

interface GooglePlacesHookProps {
  apiKey?: string;
  enabled?: boolean;
  onPlaceSelected?: (place: GooglePlaceResult) => void;
}

export interface GooglePlaceResult {
  formatted_address: string;
  place_id?: string;
  address_components?: Array<{
    long_name: string;
    short_name: string;
    types: string[];
  }>;
  geometry?: {
    location?: {
      lat: () => number;
      lng: () => number;
    };
  };
  rawPlace?: any;
}

/**
 * Binds Google's current Place Autocomplete Data API to an existing input.
 * This keeps each screen's native input and styling while avoiding the
 * legacy google.maps.places.Autocomplete constructor.
 */
export function useGooglePlaces({
  apiKey,
  enabled = true,
  onPlaceSelected,
}: GooglePlacesHookProps = {}) {
  const [scriptLoaded, setScriptLoaded] = useState(false);
  const [inputElement, setInputElement] = useState<HTMLInputElement | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const onPlaceSelectedRef = useRef(onPlaceSelected);
  onPlaceSelectedRef.current = onPlaceSelected;

  const bindInputRef = useCallback((element: HTMLInputElement | null) => {
    inputRef.current = element;
    setInputElement(element);
  }, []);

  useEffect(() => {
    if (!enabled || !inputElement) return;

    let active = true;
    let teardown: (() => void) | undefined;

    async function initialize() {
      try {
        await loadGoogleMapsApi(apiKey);
        if (!active || !inputElement) return;

        const places = await window.google.maps.importLibrary('places');
        const AutocompleteSuggestion = places.AutocompleteSuggestion;
        const AutocompleteSessionToken = places.AutocompleteSessionToken;
        if (!AutocompleteSuggestion || !AutocompleteSessionToken) {
          throw new Error('Google Place Autocomplete Data API is unavailable');
        }

        setScriptLoaded(true);

        const parent = inputElement.parentElement;
        if (!parent) return;

        const previousParentPosition = parent.style.position;
        if (window.getComputedStyle(parent).position === 'static') {
          parent.style.position = 'relative';
        }

        const listId = `google-places-${Math.random().toString(36).slice(2)}`;
        const list = document.createElement('div');
        list.id = listId;
        list.className = 'google-places-suggestions';
        list.setAttribute('role', 'listbox');
        Object.assign(list.style, {
          display: 'none',
          position: 'absolute',
          left: `${inputElement.offsetLeft}px`,
          top: `${inputElement.offsetTop + inputElement.offsetHeight + 4}px`,
          width: `${inputElement.offsetWidth}px`,
          maxHeight: '18rem',
          overflowY: 'auto',
          zIndex: '100000',
          background: '#ffffff',
          border: '1px solid rgba(15, 23, 42, 0.18)',
          borderRadius: '0.5rem',
          boxShadow: '0 10px 25px rgba(15, 23, 42, 0.16)',
        });
        parent.appendChild(list);

        const previousAria = {
          role: inputElement.getAttribute('role'),
          expanded: inputElement.getAttribute('aria-expanded'),
          autocomplete: inputElement.getAttribute('aria-autocomplete'),
          controls: inputElement.getAttribute('aria-controls'),
        };
        inputElement.setAttribute('role', 'combobox');
        inputElement.setAttribute('aria-expanded', 'false');
        inputElement.setAttribute('aria-autocomplete', 'list');
        inputElement.setAttribute('aria-controls', listId);

        let sessionToken: any | null = null;
        type UnitAwarePrediction = Readonly<{ prediction: any; unit?: string }>;
        let predictions: UnitAwarePrediction[] = [];
        let selectedIndex = -1;
        let debounceTimer: ReturnType<typeof setTimeout> | undefined;
        let blurTimer: ReturnType<typeof setTimeout> | undefined;
        let requestId = 0;
        let selectionGeneration = 0;

        const hideList = () => {
          list.style.display = 'none';
          list.replaceChildren();
          predictions = [];
          selectedIndex = -1;
          inputElement.setAttribute('aria-expanded', 'false');
          inputElement.removeAttribute('aria-activedescendant');
        };

        const abandonSession = () => {
          requestId += 1;
          selectionGeneration += 1;
          sessionToken = null;
          hideList();
        };

        const getSessionToken = () => {
          if (!sessionToken) sessionToken = new AutocompleteSessionToken();
          return sessionToken;
        };

        const highlight = () => {
          Array.from(list.children).forEach((child, index) => {
            const element = child as HTMLElement;
            const selected = index === selectedIndex;
            element.style.background = selected ? '#f1f5f9' : '#ffffff';
            element.setAttribute('aria-selected', String(selected));
          });
          const activeOption = list.children[selectedIndex] as HTMLElement | undefined;
          if (activeOption) {
            inputElement.setAttribute('aria-activedescendant', activeOption.id);
            activeOption.scrollIntoView({ block: 'nearest' });
          } else {
            inputElement.removeAttribute('aria-activedescendant');
          }
        };

        const selectPrediction = async ({ prediction, unit }: UnitAwarePrediction) => {
          requestId += 1;
          const currentSelectionGeneration = ++selectionGeneration;
          hideList();
          // The selected prediction retains its token association. Clear our
          // reference now so any new typing starts a separate session while
          // this selection's place details are still in flight.
          sessionToken = null;
          const fallbackAddress = addressWithUnit(prediction?.text?.text || '', unit);
          let place: any;

          try {
            place = prediction.toPlace();
            await place.fetchFields({
              fields: ['formattedAddress', 'id', 'addressComponents', 'location'],
            });
          } catch (error) {
            console.warn('Google place details unavailable; using the selected address text.', error);
          }

          if (!active || currentSelectionGeneration !== selectionGeneration) return;
          const formattedAddress = addressWithUnit(place?.formattedAddress || fallbackAddress, unit);
          if (!formattedAddress) return;

          inputElement.value = formattedAddress;
          const location = place?.location;
          const result: GooglePlaceResult = {
            formatted_address: formattedAddress,
            place_id: place?.id || prediction?.placeId,
            address_components: componentsWithUnit(place?.addressComponents?.map((component: any) => ({
              long_name: component.longText || '',
              short_name: component.shortText || component.longText || '',
              types: component.types || [],
            })), unit),
            geometry: location ? { location } : undefined,
            rawPlace: place,
          };
          onPlaceSelectedRef.current?.(result);
        };

        const renderPredictions = (nextPredictions: UnitAwarePrediction[]) => {
          predictions = nextPredictions.slice(0, 6);
          selectedIndex = -1;
          list.replaceChildren();

          predictions.forEach((entry, index) => {
            const { prediction, unit } = entry;
            const option = document.createElement('div');
            option.id = `${listId}-option-${index}`;
            option.setAttribute('role', 'option');
            option.setAttribute('aria-selected', 'false');
            option.textContent = addressWithUnit(prediction?.text?.text || '', unit);
            if (unit) {
              option.setAttribute(
                'aria-label',
                `${option.textContent}. Unit ${unit} was entered by you.`,
              );
              option.title = 'Unit entered by you; building address suggested by Google';
            }
            Object.assign(option.style, {
              padding: '0.7rem 0.85rem',
              cursor: 'pointer',
              color: '#0f172a',
              fontSize: '0.875rem',
              lineHeight: '1.3rem',
              borderBottom: index === predictions.length - 1 ? 'none' : '1px solid #e2e8f0',
            });
            option.addEventListener('mouseenter', () => {
              selectedIndex = index;
              highlight();
            });
            option.addEventListener('mousedown', event => event.preventDefault());
            option.addEventListener('click', () => void selectPrediction(entry));
            list.appendChild(option);
          });

          const isOpen = predictions.length > 0;
          list.style.display = isOpen ? 'block' : 'none';
          inputElement.setAttribute('aria-expanded', String(isOpen));
        };

        const requestPredictions = async () => {
          const input = inputElement.value.trim();
          const parsedInput = parsePlacesUnit(input);
          const currentRequestId = ++requestId;
          if (input.length < 3) {
            abandonSession();
            return;
          }

          try {
            const response = await AutocompleteSuggestion.fetchAutocompleteSuggestions({
              input: parsedInput.buildingInput,
              includedRegionCodes: ['us'],
              sessionToken: getSessionToken(),
            });
            if (!active || currentRequestId !== requestId) return;
            renderPredictions(
              (response.suggestions || [])
                .map((suggestion: any) => suggestion.placePrediction)
                .filter(Boolean)
                .map((prediction: any) =>
                  Object.freeze({ prediction, unit: parsedInput.unit }),
                ),
            );
          } catch (error) {
            if (currentRequestId === requestId) hideList();
            console.warn('Google address suggestions unavailable:', error);
          }
        };

        const handleInput = () => {
          requestId += 1;
          selectionGeneration += 1;
          hideList();
          if (debounceTimer) clearTimeout(debounceTimer);
          if (inputElement.value.trim().length < 3) {
            abandonSession();
            return;
          }
          debounceTimer = setTimeout(() => void requestPredictions(), 180);
        };
        const handleFocus = () => {
          if (blurTimer) clearTimeout(blurTimer);
          if (inputElement.value.trim().length >= 3) handleInput();
        };
        const handleBlur = () => {
          blurTimer = setTimeout(abandonSession, 150);
        };
        const handleKeyDown = (event: KeyboardEvent) => {
          if (event.key === 'Escape') {
            const suggestionsAreOpen =
              list.style.display !== 'none' && predictions.length > 0;
            if (suggestionsAreOpen) event.preventDefault();
            abandonSession();
            return;
          }
          if (list.style.display === 'none' || predictions.length === 0) return;
          if (event.key === 'ArrowDown') {
            event.preventDefault();
            selectedIndex = (selectedIndex + 1) % predictions.length;
            highlight();
          } else if (event.key === 'ArrowUp') {
            event.preventDefault();
            selectedIndex = selectedIndex <= 0 ? predictions.length - 1 : selectedIndex - 1;
            highlight();
          } else if (event.key === 'Enter') {
            event.preventDefault();
            event.stopPropagation();
            void selectPrediction(predictions[selectedIndex >= 0 ? selectedIndex : 0]);
          }
        };

        inputElement.addEventListener('input', handleInput);
        inputElement.addEventListener('focus', handleFocus);
        inputElement.addEventListener('blur', handleBlur);
        inputElement.addEventListener('keydown', handleKeyDown);

        teardown = () => {
          requestId += 1;
          if (debounceTimer) clearTimeout(debounceTimer);
          if (blurTimer) clearTimeout(blurTimer);
          inputElement.removeEventListener('input', handleInput);
          inputElement.removeEventListener('focus', handleFocus);
          inputElement.removeEventListener('blur', handleBlur);
          inputElement.removeEventListener('keydown', handleKeyDown);
          list.remove();
          parent.style.position = previousParentPosition;

          const restoreAttribute = (name: string, value: string | null) => {
            if (value === null) inputElement.removeAttribute(name);
            else inputElement.setAttribute(name, value);
          };
          restoreAttribute('role', previousAria.role);
          restoreAttribute('aria-expanded', previousAria.expanded);
          restoreAttribute('aria-autocomplete', previousAria.autocomplete);
          restoreAttribute('aria-controls', previousAria.controls);
          inputElement.removeAttribute('aria-activedescendant');
        };
      } catch (error) {
        if (active) console.warn('Google Maps autocomplete unavailable:', error);
      }
    }

    void initialize();
    return () => {
      active = false;
      teardown?.();
    };
  }, [apiKey, enabled, inputElement]);

  return {
    bindInputRef,
    inputRef,
    isLoaded: scriptLoaded && !!window.google?.maps?.places,
    autocomplete: null,
  };
}
