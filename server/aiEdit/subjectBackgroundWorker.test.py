"""Focused regression for a source-preserving fill touching the frame edge."""
import unittest
import cv2
import numpy as np
from subjectBackgroundWorker import match_boundary, continue_structure


class BackgroundBoundaryTest(unittest.TestCase):
    def test_matches_observed_illumination_without_changing_known_pixels(self):
        y,x=np.indices((80,144),dtype=np.float32)
        truth=np.stack([100+x*.2+y*.1,130+x*.2+y*.1,160+x*.2+y*.1],axis=2).astype(np.uint8)
        unknown=np.zeros((80,144),np.uint8);unknown[30:,:55]=255
        observed=truth.copy();observed[unknown>0]=0
        copied=np.clip(truth.astype(int)+35,0,255).astype(np.uint8)
        result=match_boundary(observed,copied,unknown)
        self.assertTrue(np.array_equal(result[unknown==0],truth[unknown==0]))
        self.assertLessEqual(np.max(np.abs(result.astype(int)-truth.astype(int))),2)
        # Seek a flat wall boundary: the old wider-clone/restore approach left a step.
        self.assertLessEqual(np.max(np.abs(result[31:,54].astype(int)-result[31:,55].astype(int))),2)

    def test_does_not_invent_a_structural_direction_on_a_flat_scene(self):
        observed=np.full((180,320,3),150,np.uint8)
        unknown=np.zeros((180,320),np.uint8);unknown[90:,:60]=255
        observed[unknown>0]=0
        result,metadata=continue_structure(observed,unknown)
        self.assertIsNone(result)
        self.assertIsNone(metadata)


if __name__=='__main__':unittest.main()
