# Scrypted basic object detector

Simple proxy to base detection plugins (coreMl, OV,...) to provide basic object detection to cameras not attached to NVR. 
Unlike NVR, this plugin won't care about the system load, it's suggested to allocate an object detector in the cluster not set al compute preferred