"""Atlas: a map of anything, for NeuroClaw / OpenBrain.

Put data in space so that redundant data goes away and good data is kept. A map is a set of *marks*: what kind of
thing, where (in whatever space fits), when, how much, and what it is about. A depth pixel, a whiff of gas, a file,
a note, random bytes and how many people liked a video are all marks. See ``docs/ATLAS.md``.

``atlas_core.py`` is the whole brain and is shared, byte for byte, with the KOS operating system (kernal-os,
``suite/atlas_core.py``); ``CORE_SHA256`` records which version this is, and a test fails if the two drift.
Standard library only. Nothing here runs by itself and nothing is installed to start at boot."""

__version__ = "1.0"
