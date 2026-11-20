(function(){
  const chain = () => new Proxy(function(){}, { get: (t,k) => k === 'getZoom' ? () => 19 : k === 'getLatLng' ? () => ({lat:40.0801,lng:-74.2101}) : k === 'getContainer' ? () => document.getElementById('map') : k === 'hasLayer' ? () => true : chain, apply: () => chain() });
  window.L = {
    map: () => chain(), tileLayer: () => chain(), layerGroup: () => chain(), circle: () => chain(),
    marker: () => chain(), divIcon: () => ({}), latLngBounds: () => ({}),
    Control: { extend: (o) => function(){ return { addTo(){ const d=o.onAdd(); d.style.cssText='position:absolute;right:8px;top:60px;z-index:999'; document.getElementById('map').appendChild(d); } }; } },
    DomUtil: { create: (tag, cls) => { const e=document.createElement(tag); e.className=cls; return e; } },
    DomEvent: { disableClickPropagation(){} },
  };
})();