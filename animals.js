/**
 * Footprints – selectable retrace guide (FAB + replay mascot). Shared by popup + content script.
 */
(function (g) {
  'use strict';

  g.FOOTPRINTS_MASCOT_STORAGE_KEY = 'fpMascotAnimalId';
  g.FOOTPRINTS_DEFAULT_MASCOT_ID = 'bunny';

  g.FOOTPRINTS_ANIMALS = [
    { id: 'bunny', label: 'Bunny', path: 'icons/mascot-256.png' },
    { id: 'fox', label: 'Fox', path: 'icons/mascot-fox.png' },
    { id: 'raccoon', label: 'Raccoon', path: 'icons/mascot-raccoon.png' },
    { id: 'owl', label: 'Owl', path: 'icons/mascot-owl.png' },
  ];

  g.getFootprintsAnimal = function (id) {
    if (id === 'cat') id = 'raccoon';
    var list = g.FOOTPRINTS_ANIMALS;
    for (var i = 0; i < list.length; i++) {
      if (list[i].id === id) return list[i];
    }
    return list[0];
  };
})(typeof globalThis !== 'undefined' ? globalThis : window);
